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

# 创建 session 目录（用于主容器 bind mount）
# 创建 session_data 目录（用于多开容器 volume mount）
# 必须在镜像中创建这些目录，避免 Docker overlay 文件系统只读问题
RUN mkdir -p /app/session /app/session_data

# 启动应用
ENTRYPOINT ["/entrypoint.sh"]
CMD ["python", "-u", "monitor.py"]
