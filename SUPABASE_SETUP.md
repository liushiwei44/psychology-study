# Supabase 与 GitHub Pages 配置

当前实现是“本地立即保存、登录后自动合并到云端”。即使 Supabase 暂时断网，刷题仍可继续；网络恢复并再次产生记录后会重新同步。

## 1. 创建 Supabase 项目

如果目前只是注册了 Supabase 账号，还需要在 Dashboard 中创建一个项目。项目区域尽量选择离自己近的区域，数据库密码妥善保存；浏览器端不会使用这个密码。

## 2. 创建学习记录表

进入 Supabase 项目的 **SQL Editor**，新建查询，把 [`supabase/schema.sql`](./supabase/schema.sql) 的全部内容粘贴进去并执行。

执行后，在 **Table Editor** 中应看到 `study_states`。它采用“一位用户一行 JSON 学习状态”的 MVP 结构，并已开启 RLS：登录用户只能读写 `user_id` 等于自己账号 ID 的记录。

## 3. 开启 GitHub 登录

1. 在 Supabase 进入 **Authentication → Sign In / Providers → GitHub**。
2. 记下页面展示的 callback URL，格式通常是：

   ```text
   https://你的项目引用.supabase.co/auth/v1/callback
   ```

3. 打开 GitHub **Settings → Developer settings → OAuth Apps → New OAuth App**。
4. Homepage URL 填最终网站地址，例如：

   ```text
   https://你的GitHub用户名.github.io/仓库名/
   ```

5. Authorization callback URL 填第 2 步的 Supabase callback URL。
6. 在 GitHub 生成 Client Secret，把 Client ID 和 Client Secret 填回 Supabase 的 GitHub Provider 并保存。

注意：GitHub OAuth App 的 callback 指向 Supabase，不是 GitHub Pages 地址。

## 4. 配置允许跳转的网址

在 Supabase 进入 **Authentication → URL Configuration**：

- Site URL：填最终 GitHub Pages 地址。
- Redirect URLs：至少加入以下两个地址：

  ```text
  http://127.0.0.1:4173/**
  https://你的GitHub用户名.github.io/仓库名/**
  ```

如果也会用 `localhost` 启动，可再加 `http://localhost:4173/**`。

## 5. 填写前端公开配置

在 Supabase 项目设置中找到 Project URL 和 publishable key，然后填写 [`config.js`](./config.js)：

```js
export const SUPABASE_URL = 'https://你的项目引用.supabase.co';
export const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_...';
```

Project URL 和 publishable/anon key 本来就会出现在浏览器中，可以随静态网站发布；安全边界由 RLS 保证。

绝对不要把以下内容放进 `config.js`、GitHub 仓库或任何前端文件：

- `service_role` key
- secret key
- 数据库密码
- GitHub OAuth Client Secret

## 6. 本机验证

在项目目录运行：

```bash
python3 -m http.server 4173 --bind 127.0.0.1
```

打开 <http://127.0.0.1:4173/>，点击右上角“登录同步”。GitHub 授权返回后，状态应依次显示“正在同步…”和“云端已同步”。在 Supabase 的 `study_states` 表中也应出现当前用户的一行。

第一次登录会合并当前浏览器已有的本机记录与云端记录，不会直接覆盖其中一端。

## 7. 发布到 GitHub Pages

1. 在 GitHub 新建仓库。
2. 把本项目提交并推送到仓库的 `main` 分支。
3. 进入仓库 **Settings → Pages**，Source 选择 **GitHub Actions**。
4. 推送后，仓库内置的 [`.github/workflows/deploy-pages.yml`](./.github/workflows/deploy-pages.yml) 会自动发布。

发布产物只包含页面、同步脚本和 `data/` 下的结构化题库，不包含原始 PDF、导入脚本或项目文档。`.gitignore` 也会阻止两份 PDF 被新提交到 Git。

## 8. 换设备后的使用方式

在手机或另一台电脑打开同一个 GitHub Pages 地址，用同一个 GitHub 账号登录。系统会把该设备本机记录与账号云端记录按题目最后作答时间合并，然后继续自动同步。

注意：退出登录只停止云同步，不会清除当前设备的本机记录。如果使用公共设备，结束后可在“学习统计”页手动清空本机学习记录。

