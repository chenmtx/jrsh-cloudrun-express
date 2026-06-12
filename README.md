# 今日食何云托管后端

把本目录内容复制到微信云托管 Express 模板仓库根目录，然后重新部署服务。

需要保留或配置这些环境变量：

```text
MYSQL_ADDRESS
MYSQL_USERNAME
MYSQL_PASSWORD
MYSQL_DATABASE
```

其中 `MYSQL_DATABASE` 可以不填，默认使用模板数据库 `nodejs_demo`。

接口：

```text
GET  /health
POST /api/login
POST /api/bootstrap
GET  /api/kitchens/:id/state
POST /api/kitchens/:id/state
```
