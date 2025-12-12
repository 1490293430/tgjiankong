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
        
        log_debug(f"断开连接...")
        await client.disconnect()
        
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
        
        # 等待一小段时间确保文件写入完成
        import asyncio
        await asyncio.sleep(1.0)  # 增加到 1 秒，确保文件完全写入
        
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

