#!/usr/bin/env python3
"""Local-only credential input; never prints a credential."""
import getpass
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile

LOCATION = Path.home() / '.config' / 'repo-demo-recorder' / 'credentials.json'

def prompt_key():
    if not sys.stdin.isatty():
        raise RuntimeError('请在本地交互终端输入 key，不接受聊天或管道输入。')
    value = getpass.getpass('Doubao TTS API key (hidden): ').strip()
    if not value:
        raise RuntimeError('key 不能为空。')
    return value

def main():
    args = sys.argv[1:]
    if args == ['setup']:
        if os.name != 'posix':
            raise RuntimeError('Windows 请使用 run 隐藏输入，或由密码管理器注入环境变量。')
        value = prompt_key()
        if LOCATION.is_symlink() or LOCATION.parent.is_symlink():
            raise RuntimeError('拒绝使用符号链接凭据路径。')
        LOCATION.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        os.chmod(LOCATION.parent, 0o700)
        fd, temporary = tempfile.mkstemp(dir=LOCATION.parent, prefix='.credential-')
        try:
            with os.fdopen(fd, 'w') as stream:
                json.dump({'DOUBAO_TTS_API_KEY': value}, stream)
                stream.write('\n')
            os.replace(temporary, LOCATION)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        print('凭据已保存，仅当前用户可读写。')
        return 0
    if len(args) >= 2 and args[0] == 'run':
        env = os.environ.copy()
        value = env.get('DOUBAO_TTS_API_KEY') or env.get('VOLCENGINE_TTS_API_KEY')
        if not value and os.name == 'posix' and LOCATION.exists():
            if LOCATION.is_symlink() or LOCATION.parent.is_symlink():
                raise RuntimeError('拒绝读取符号链接凭据。')
            info = LOCATION.stat()
            if info.st_uid != os.getuid() or info.st_mode & 0o077:
                raise RuntimeError('凭据文件所有者或权限不正确，需要当前用户所有且权限 600。')
            value = json.loads(LOCATION.read_text()).get('DOUBAO_TTS_API_KEY')
        env['DOUBAO_TTS_API_KEY'] = value or prompt_key()
        return subprocess.run(args[1:], env=env, shell=False).returncode
    print('Usage: python3 credentials.py setup | run <executable> [args...]')
    return 0 if args in ([], ['--help']) else 2

if __name__ == '__main__':
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError):
        print('凭据操作失败：请检查交互终端、文件权限和命令路径。Windows 使用 run；未输出任何凭据。', file=sys.stderr)
        sys.exit(1)
