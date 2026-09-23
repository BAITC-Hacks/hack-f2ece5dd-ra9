import argparse
import uvicorn
from .app import create_app

parser = argparse.ArgumentParser(description='Локальный сервер записи совещаний')
parser.add_argument('--port', type=int, default=8765)
args = parser.parse_args()
uvicorn.run(create_app(), host='127.0.0.1', port=args.port, access_log=False)
