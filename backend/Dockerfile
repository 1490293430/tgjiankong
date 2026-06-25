FROM node:18-alpine

WORKDIR /app

# 安装时区数据，让容器内 date 与 Node 本地时间都使用 TZ 设置
RUN apk add --no-cache tzdata

# 复制依赖文件
COPY package.json ./

# 安装依赖
RUN npm install --production

# 复制应用代码
COPY . .

# 暴露端口
EXPOSE 3000

# 启动应用
CMD ["node", "server.js"]
