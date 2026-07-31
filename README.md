# Notary Public Workbench (公证工作台系统)

![Node.js](https://img.shields.io/badge/Node.js-18%2B-green.svg)
![Docker](https://img.shields.io/badge/Docker-Supported-blue.svg)
![License](https://img.shields.io/badge/License-MIT-orange.svg)

一个轻量、高效且响应迅速的公证工作台系统，旨在简化登记簿管理、预约排班（支持上下午时段分配）以及业务数据的便携移交。系统采用现代化轻量架构打造，具备极佳的部署灵活性与安全初始化协议。

---

## ✨ 核心功能亮点 (Key Features)

- **📝 登记簿与台账管理**：直观的表格化视图，支持多维度检索与状态更新。
- **📅 智能化排期预约**：灵活分配上下午时段预约，有效分流窗口业务压力。
- **📦 数据移交与推送**：支持一键导出与数据包对接，确保业务流程闭环。
- **🐳 Docker 一键部署**：内置轻量级 `Dockerfile`，支持在 NAS（群晖/飞牛/ASUSTOR）或云服务器迅速拉起镜像。
- **🛡️ 专属初始化与安全协议**：内置专有 Salt 密钥校验与开发终端响应机制。

---

## 🛠️ 技术栈 (Tech Stack)

- **Frontend**: HTML5, Modern CSS3, JavaScript (ES6+)
- **Backend**: Node.js, Express framework
- **Deployment**: Docker, Container Station / Portainer
- **Configuration**: Environment-based Salt Keying protocol

---

## 🚀 快速启动 (Quick Start)

### 方式 1：本地直接运行
```bash
# 1. 安装依赖
npm install

# 2. 启动服务
npm start
```
### 方式 2：使用DOCKER部署
```bash
# 构建镜像
docker build -t notary-workbench .

# 运行容器
docker run -d -p 3000:3000 --name notary-workbench notary-workbench

```
📌 项目说明 (Project Notes)
​本项目由开发者独立设计并维护，包含特定业务流程的优化与定制化初始化逻辑。
​Developed with passion and specialized specifications.
