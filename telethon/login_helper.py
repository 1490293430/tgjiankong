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
    try:
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
        
        result = await client.send_code_request(phone)
        await client.disconnect()
        
        print(json.dumps({
            'success': True,
            'phone_code_hash': result.phone_code_hash
        }))
    except FloodWaitError as e:
        print(json.dumps({
            'success': False,
            'error': f'请求过于频繁，请等待 {e.seconds} 秒后重试',
            'flood_wait': e.seconds
        }))
    except Exception as e:
        print(json.dumps({
            'success': False,
            'error': str(e)
        }))

async def sign_in(phone, code, phone_code_hash, password, session_path, api_id, api_hash):
    """登录"""
    try:
        client = TelegramClient(session_path, api_id, api_hash)
        await client.connect()
        
        try:
            await client.sign_in(phone, code, phone_code_hash=phone_code_hash)
        except SessionPasswordNeededError:
            if password:
                await client.sign_in(password=password)
            else:
                await client.disconnect()
                print(json.dumps({
                    'success': False,
                    'password_required': True,
                    'message': '需要两步验证密码'
                }))
                return
        
        me = await client.get_me()
        await client.disconnect()
        
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

