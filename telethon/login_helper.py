#!/usr/bin/env python3
"""
Telegram 登录辅助脚本
用于通过命令行参数进行登录操作
"""
import sys
import os
import asyncio
import json
from telethon import TelegramClient
from telethon.errors import SessionPasswordNeededError, FloodWaitError

async def check_login_status(session_path, api_id, api_hash):
    """检查登录状态"""
    try:
        client = TelegramClient(session_path, api_id, api_hash)
        await client.connect()
        
        if await client.is_user_authorized():
            me = await client.get_me()
            await client.disconnect()
            print(json.dumps({
                'success': True,
                'logged_in': True,
                'user': {
                    'id': str(me.id),
                    'first_name': me.first_name,
                    'last_name': getattr(me, 'last_name', None),
                    'username': me.username
                }
            }))
        else:
            await client.disconnect()
            print(json.dumps({
                'success': True,
                'logged_in': False
            }))
    except Exception as e:
        print(json.dumps({
            'success': False,
            'error': str(e)
        }))

async def send_code(phone, session_path, api_id, api_hash):
    """发送验证码"""
    import json as json_module
    import sys
    import os
    
    # 添加详细日志到 stderr（不影响 JSON 输出）
    def log_debug(msg):
        print(f"[DEBUG] {msg}", file=sys.stderr, flush=True)
    
    try:
        log_debug(f"=== 发送验证码流程 ===")
        log_debug(f"Session 路径: {session_path}")
        log_debug(f"手机号: {phone}")
        
        # 检查目录和文件
        session_dir = os.path.dirname(session_path)
        log_debug(f"Session 目录: {session_dir}")
        log_debug(f"目录是否存在: {os.path.exists(session_dir)}")
        if os.path.exists(session_dir):
            log_debug(f"目录内容: {os.listdir(session_dir)}")
        
        client = TelegramClient(session_path, api_id, api_hash)
        await client.connect()
        
        if await client.is_user_authorized():
            me = await client.get_me()
            await client.disconnect()
            print(json.dumps({
                'success': True,
                'already_logged_in': True,
                'user': {
                    'id': str(me.id),
                    'first_name': me.first_name,
                    'username': me.username
                }
            }))
            return
        
        log_debug(f"发送验证码请求...")
        result = await client.send_code_request(phone)
        await client.disconnect()
        log_debug(f"验证码已发送，phone_code_hash: {result.phone_code_hash}")
        
        print(json.dumps({
            'success': True,
            'phone_code_hash': result.phone_code_hash
        }))
    except FloodWaitError as e:
        log_debug(f"请求过于频繁，需等待 {e.seconds} 秒")
        print(json.dumps({
            'success': False,
            'error': f'请求过于频繁，请等待 {e.seconds} 秒后重试',
            'flood_wait': e.seconds
        }))
    except Exception as e:
        import traceback
        log_debug(f"❌ 发送验证码失败: {str(e)}")
        log_debug(f"错误堆栈: {traceback.format_exc()}")
        print(json.dumps({
            'success': False,
            'error': str(e)
        }))

async def sign_in(phone, code, phone_code_hash, password, session_path, api_id, api_hash):
    """登录"""
    import json as json_module
    import sys
    
    # 添加详细日志到 stderr（不影响 JSON 输出）
    def log_debug(msg):
        print(f"[DEBUG] {msg}", file=sys.stderr, flush=True)
    
    try:
        log_debug(f"=== 开始登录流程 ===")
        log_debug(f"Session 路径: {session_path}")
        log_debug(f"API ID: {api_id}")
        
        # 检查登录前的文件状态
        session_file = f"{session_path}.session"
        session_journal = f"{session_path}.session-journal"
        log_debug(f"预期 Session 文件: {session_file}")
        log_debug(f"预期 Journal 文件: {session_journal}")
        
        # 检查目录是否存在
        import os
        session_dir = os.path.dirname(session_path)
        log_debug(f"Session 目录: {session_dir}")
        log_debug(f"目录是否存在: {os.path.exists(session_dir)}")
        if os.path.exists(session_dir):
            log_debug(f"目录权限: {oct(os.stat(session_dir).st_mode)}")
            log_debug(f"目录内容: {os.listdir(session_dir)}")
        
        # 检查登录前文件是否存在
        log_debug(f"登录前 Session 文件存在: {os.path.exists(session_file)}")
        log_debug(f"登录前 Journal 文件存在: {os.path.exists(session_journal)}")
        
        log_debug(f"创建 TelegramClient...")
        client = TelegramClient(session_path, api_id, api_hash)
        log_debug(f"连接 Telegram...")
        await client.connect()
        
        try:
            log_debug(f"发送验证码进行登录...")
            await client.sign_in(phone, code, phone_code_hash=phone_code_hash)
        except SessionPasswordNeededError:
            log_debug(f"需要两步验证密码")
            if password:
                log_debug(f"使用密码进行两步验证...")
                await client.sign_in(password=password)
            else:
                await client.disconnect()
                print(json.dumps({
                    'success': False,
                    'password_required': True,
                    'message': '需要两步验证密码'
                }))
                return
        
        log_debug(f"登录成功，获取用户信息...")
        me = await client.get_me()
        log_debug(f"用户信息: {me.first_name} (ID: {me.id})")
        
        # 在断开连接前，检查 journal 文件是否存在（写入过程中会存在）
        log_debug(f"=== 断开连接前检查 ===")
        log_debug(f"断开前 Session 文件存在: {os.path.exists(session_file)}")
        log_debug(f"断开前 Journal 文件存在: {os.path.exists(session_journal)}")
        
        # 在断开连接前，确保 session 已保存
        log_debug(f"确保 session 已保存...")
        await client.disconnect()
        
        # 立即检查 journal 文件（断开连接后，SQLite 可能会立即删除 journal 文件）
        log_debug(f"=== 断开连接后立即检查 ===")
        log_debug(f"断开后立即检查 - Session 文件存在: {os.path.exists(session_file)}")
        log_debug(f"断开后立即检查 - Journal 文件存在: {os.path.exists(session_journal)}")
        
        # 如果 journal 文件存在，说明写入正在进行中，需要等待
        if os.path.exists(session_journal):
            log_debug(f"⚠️  Journal 文件存在，说明写入正在进行中，等待完成...")
            # 轮询检查 journal 文件，直到它被删除（说明写入完成）
            max_wait = 10  # 最多等待 10 秒
            wait_count = 0
            while os.path.exists(session_journal) and wait_count < max_wait:
                await asyncio.sleep(0.5)
                wait_count += 0.5
                log_debug(f"等待 Journal 文件删除... ({wait_count} 秒)")
            
            if os.path.exists(session_journal):
                log_debug(f"⚠️  警告：Journal 文件在等待 {max_wait} 秒后仍然存在，可能写入失败")
            else:
                log_debug(f"✅ Journal 文件已被删除，说明写入已完成")
        else:
            log_debug(f"✅ Journal 文件不存在，说明写入已完成或未使用 journal 模式")
        
        # 显式同步文件系统，确保文件写入磁盘
        import sys
        try:
            sys.stdout.flush()
            sys.stderr.flush()
            # 使用 sync 命令强制同步文件系统
            import subprocess
            try:
                subprocess.run(['sync'], check=False, timeout=5)
                log_debug(f"已执行 sync 命令同步文件系统")
            except Exception as sync_error:
                log_debug(f"执行 sync 失败（不影响功能）: {sync_error}")
        except Exception as e:
            log_debug(f"同步文件系统时出错（不影响功能）: {e}")
        
        # 再等待一小段时间确保文件完全同步
        await asyncio.sleep(1.0)
        
        # 验证 session 文件是否可以被正确读取（使用更严格的验证）
        log_debug(f"=== 验证 Session 文件可读性 ===")
        log_debug(f"验证使用的 Session 路径: {session_path}")
        log_debug(f"验证使用的 API_ID: {api_id}")
        log_debug(f"验证使用的 API_HASH: {'已设置' if api_hash else '未设置'}")
        
        # 检查 session 文件是否存在
        session_file_verify = f"{session_path}.session"
        log_debug(f"验证 Session 文件路径: {session_file_verify}")
        log_debug(f"Session 文件存在: {os.path.exists(session_file_verify)}")
        if os.path.exists(session_file_verify):
            file_stat = os.stat(session_file_verify)
            log_debug(f"Session 文件大小: {file_stat.st_size} 字节")
        
        verify_success = False
        try:
            verify_client = TelegramClient(session_path, api_id, api_hash)
            await verify_client.connect()
            
            # 先检查授权状态
            is_authorized = await verify_client.is_user_authorized()
            log_debug(f"验证结果 - 授权状态: {is_authorized}")
            
            if is_authorized:
                # 如果授权状态为 True，尝试获取用户信息确认
                try:
                    verify_me = await verify_client.get_me()
                    log_debug(f"验证结果 - 用户: {verify_me.first_name} (ID: {verify_me.id})")
                    if str(verify_me.id) != str(me.id):
                        log_debug(f"⚠️  警告：验证用户 ID 不匹配！")
                    else:
                        verify_success = True
                        log_debug(f"✅ Session 文件验证成功")
                except Exception as get_me_error:
                    log_debug(f"⚠️  获取用户信息失败: {get_me_error}")
            else:
                # 如果授权状态为 False，尝试启动客户端验证（因为 is_user_authorized() 可能不准确）
                log_debug(f"⚠️  授权状态为 False，尝试启动客户端验证...")
                try:
                    await verify_client.start()
                    verify_me = await verify_client.get_me()
                    log_debug(f"✅ 客户端启动成功，Session 文件有效（is_user_authorized() 可能不准确）")
                    log_debug(f"验证结果 - 用户: {verify_me.first_name} (ID: {verify_me.id})")
                    if str(verify_me.id) == str(me.id):
                        verify_success = True
                        log_debug(f"✅ Session 文件验证成功")
                    else:
                        log_debug(f"⚠️  警告：验证用户 ID 不匹配！")
                except EOFError as eof_err:
                    log_debug(f"❌ EOFError: Session 文件无效，无法启动客户端: {eof_err}")
                except Exception as start_error:
                    log_debug(f"⚠️  启动客户端失败: {start_error}")
            
            await verify_client.disconnect()
        except Exception as verify_error:
            log_debug(f"⚠️  验证 Session 文件时出错: {verify_error}")
            import traceback
            log_debug(f"验证错误堆栈: {traceback.format_exc()}")
        
        if not verify_success:
            log_debug(f"⚠️  警告：Session 文件验证失败，但继续返回成功（可能需要在 Telethon 服务中重试）")
        
        # 检查登录后的文件状态
        log_debug(f"=== 登录后文件检查 ===")
        log_debug(f"登录后 Session 文件存在: {os.path.exists(session_file)}")
        log_debug(f"登录后 Journal 文件存在: {os.path.exists(session_journal)}")
        
        if os.path.exists(session_file):
            file_stat = os.stat(session_file)
            log_debug(f"Session 文件大小: {file_stat.st_size} 字节")
            log_debug(f"Session 文件权限: {oct(file_stat.st_mode)}")
            log_debug(f"Session 文件修改时间: {file_stat.st_mtime}")
            
            # 尝试读取文件内容验证文件完整性
            try:
                with open(session_file, 'rb') as f:
                    file_content = f.read()
                    log_debug(f"Session 文件可读，内容长度: {len(file_content)} 字节")
                    if len(file_content) == 0:
                        log_debug(f"⚠️  Session 文件为空！")
            except Exception as read_error:
                log_debug(f"⚠️  无法读取 Session 文件: {read_error}")
        else:
            log_debug(f"⚠️  Session 文件不存在！")
            # 列出目录内容
            if os.path.exists(session_dir):
                log_debug(f"目录内容: {os.listdir(session_dir)}")
        
        if os.path.exists(session_journal):
            log_debug(f"Journal 文件大小: {os.stat(session_journal).st_size} 字节")
        
        # 检查 volume 挂载点
        log_debug(f"检查 /tmp/session_volume 目录...")
        if os.path.exists('/tmp/session_volume'):
            log_debug(f"/tmp/session_volume 存在")
            volume_files = os.listdir('/tmp/session_volume')
            log_debug(f"/tmp/session_volume 内容: {volume_files}")
            log_debug(f"/tmp/session_volume 文件数量: {len(volume_files)}")
            
            # 检查目标文件是否在 volume 中
            target_file = os.path.basename(session_file)
            if target_file in volume_files:
                log_debug(f"✅ 目标文件 {target_file} 在 volume 中")
            else:
                log_debug(f"⚠️  目标文件 {target_file} 不在 volume 中")
        else:
            log_debug(f"⚠️  /tmp/session_volume 不存在！")
        
        print(json.dumps({
            'success': True,
            'message': f'登录成功！已登录为: {me.first_name}',
            'user': {
                'id': str(me.id),
                'first_name': me.first_name,
                'last_name': getattr(me, 'last_name', None),
                'username': me.username
            }
        }))
    except Exception as e:
        import traceback
        log_debug(f"❌ 登录失败: {str(e)}")
        log_debug(f"错误堆栈: {traceback.format_exc()}")
        print(json.dumps({
            'success': False,
            'error': str(e)
        }))

if __name__ == '__main__':
    if len(sys.argv) < 2:
        print(json.dumps({'success': False, 'error': '缺少命令参数'}))
        sys.exit(1)
    
    command = sys.argv[1]
    
    if command == 'check':
        if len(sys.argv) < 5:
            print(json.dumps({'success': False, 'error': '参数不足'}))
            sys.exit(1)
        session_path = sys.argv[2]
        api_id = int(sys.argv[3])
        api_hash = sys.argv[4]
        asyncio.run(check_login_status(session_path, api_id, api_hash))
    
    elif command == 'send_code':
        if len(sys.argv) < 6:
            print(json.dumps({'success': False, 'error': '参数不足'}))
            sys.exit(1)
        phone = sys.argv[2]
        session_path = sys.argv[3]
        api_id = int(sys.argv[4])
        api_hash = sys.argv[5]
        asyncio.run(send_code(phone, session_path, api_id, api_hash))
    
    elif command == 'sign_in':
        if len(sys.argv) < 8:
            print(json.dumps({'success': False, 'error': '参数不足'}))
            sys.exit(1)
        phone = sys.argv[2]
        code = sys.argv[3]
        phone_code_hash = sys.argv[4]
        password = sys.argv[5] if sys.argv[5] != 'None' else None
        session_path = sys.argv[6]
        api_id = int(sys.argv[7])
        api_hash = sys.argv[8]
        asyncio.run(sign_in(phone, code, phone_code_hash, password, session_path, api_id, api_hash))
    
    else:
        print(json.dumps({'success': False, 'error': f'未知命令: {command}'}))

