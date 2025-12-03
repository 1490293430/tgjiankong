FROM node:18-alpine

WORKDIR /app

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
