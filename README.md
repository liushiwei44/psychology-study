# 心理咨询师备考台 MVP

这是一个本地优先的刷题网站，针对中国心理卫生协会 2026 年心理咨询师（初级）考试设计。

## 启动

在项目目录运行：

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

然后打开：http://127.0.0.1:4173/

## 当前可用功能

- 从两个 PDF 实际解析出的 9488 道题目（单选 3996、多选 3998、判断 1494）
- 自动质检：4 道源 PDF 内容异常题暂不进入正式练习队列，详见 `data/import_report.json`
- 单选、多选、判断题的结构化题库
- 首刷模式：答案和解析在提交前隐藏
- 把握程度记录：有把握 / 模糊 / 蒙的
- 错题自动进入本地错题本
- 1 天 / 3 天 / 7 天的基础复习间隔
- 今日目标可调整（默认 50 题）
- 基础知识 / 专业技能两个 120 分钟模拟入口
- 本地统计和模拟记录
- 可选 GitHub 登录与 Supabase 跨设备同步
- 一键清空本机学习记录（不会删除 PDF 和题库）

## 重新解析 PDF

如果 PDF 更新，可以使用项目提供的导入脚本：

```bash
python3 scripts/prepare_questions.py
```

它会更新：

- `data/questions.json`
- `data/import_report.json`

导入报告会保留缺号和解析异常，不会静默丢题。

## 当前限制

- 正式考试的每类题型题量/分值仍应以官方大纲和准考证为准，MVP 模拟暂时采用可调整的 60 题等权训练模板。
- 现有 PDF 没有独立、完整的案例分析题库，案例题录入和案例组卷将在下一版加入。
- 题目知识点标签和相似题归并尚未完成。
- 未配置 Supabase 或未登录时，学习记录只保存在当前浏览器；登录后才会同步到用户自己的云端记录。

## 数据存储与分享部署

当前 MVP 是纯静态、本地优先应用，并提供可选的 Supabase 同步：

- `data/questions.json` 和 `data/import_report.json` 随网站文件一起提供，浏览器启动时读取；PDF 不参与运行时加载。
- 你的作答记录、错题、把握程度、模拟历史首先写入当前浏览器的 `localStorage`；配置 Supabase 并登录后，会自动与云端合并并同步。
- 题库 JSON 中包含答案和解析，界面只是“提交前隐藏”；因此当前版本适合个人或小范围分享，不适合作为需要保护答案内容的公开题库。

### 方案 A：GitHub Pages + Supabase（当前推荐）

GitHub Pages 托管静态页面和题库，Supabase 提供 GitHub 登录、数据库和 RLS 权限隔离。完整配置步骤见 [`SUPABASE_SETUP.md`](./SUPABASE_SETUP.md)。

仓库已经包含 GitHub Actions 发布流程。Pages 的发布产物不会包含原始 PDF。

### 方案 B：仅静态托管

把 `index.html`、`styles.css`、`app.js` 和 `data/` 一起上传到 GitHub Pages、Cloudflare Pages、Netlify、Vercel 静态站点或任意 Web 服务器即可。每个使用者拥有独立的本地学习记录，部署和维护成本最低。

### 方案 C：局域网临时分享

在项目目录运行：

```bash
python3 -m http.server 4173 --bind 0.0.0.0
```

然后让同一局域网的设备访问这台电脑的局域网 IP 和 `4173` 端口。仅建议临时使用，不要把端口直接暴露到互联网。

如果要公开分享但不希望用户直接下载答案，需要把答案校验移到服务端，通过“提交后请求结果”的接口返回答案；仅靠前端隐藏不能真正保护答案。

### 推荐的多设备架构

```text
GitHub Pages（静态页面 + 题库）
              │
              ├── Supabase Auth（登录身份）
              └── Supabase Postgres（作答、错题、备注、设置）
                         │
                 RLS：每个用户只能读写自己的记录
```

MVP 目前把一位用户的学习状态存成 `study_states` 表中的一行 JSON，避免过早引入复杂的数据表。浏览器仍保留 `localStorage` 作为离线缓存；登录后按每道题最后作答时间合并本地与云端记录。

GitHub 账号只负责代码仓库和 Pages 部署，不等于网站已经有登录/同步能力。网站登录可以接 Supabase 的邮箱密码、Magic Link 或 GitHub OAuth；前端只使用 Supabase publishable/anon key，绝不能把 service role/secret key 放进静态网站。
