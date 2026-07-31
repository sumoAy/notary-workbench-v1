FROM node:18-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install --production

COPY . .

# 创建持久化数据目录
RUN mkdir -p /app/data

EXPOSE 8080

CMD ["npm", "start"]