FROM python:3.11-slim

WORKDIR /app

# 安装依赖
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 复制应用代码
COPY monitor.py .
COPY mongo_index_init.py .
COPY login_helper.py .

# 复制 entrypoint 脚本
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# 注意：不创建 /app/session 目录
# 使用 entrypoint 脚本在容器启动时创建，避免 overlay 文件系统只读问题

# 启动应用
ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "-u", "monitor.py"]
