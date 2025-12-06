FROM python:3.11-slim

WORKDIR /app

# 安装依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制应用代码
COPY monitor.py .
COPY mongo_index_init.py .

# 创建 session 目录
RUN mkdir -p /app/session

# 启动应用
CMD ["python", "-u", "monitor.py"]
