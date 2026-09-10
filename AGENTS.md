# Codex MCP Server — Agent Onboarding

MCP server local giống Codex: đọc/ghi file, chạy lệnh, git. Dùng với ChatGPT Developer Mode hoặc bất kỳ MCP client nào.

## ChatGPT web — giảm số lượt gọi tool

Đọc context đã có trong MCP initialization trước. `agent_status` chỉ cần khi thiếu thông tin môi trường; `project_context` khi đổi project hoặc cần tài liệu chưa được nạp. Không lặp onboarding cho mỗi lượt gọi.

- Dùng **`inspect_code`** để đọc nhiều file/range hoặc grep/glob độc lập trong một lượt; kết quả đọc đã kèm path rules. Nếu `truncated=true`, đọc range hẹp hơn; không suy đoán phần bị cắt.
- Sửa nhiều file bằng **`apply_patch`** multi-file để giữ checkpoint.
- Chạy build/test bằng **`start_process`** với `working_directory` rõ ràng. Nếu `running=false`, đã có kết quả.
- Nếu còn chạy, gọi **`process_output`** với `cursor` vừa nhận và `wait_ms=10000`; tiếp tục dùng cursor mới. `has_more=true` thì đọc tiếp, `dropped=true` báo log cũ đã bị loại khỏi buffer.
- Dùng **`stop_process`** để dừng job khi cần. Không chạy lại lệnh chỉ để lấy output.

## Quyền truy cập

- Gọi `workbench` khi bắt đầu để biết task, workspace và quyền hiện tại.
- Task mới mặc định **Ask for approval + chỉ workspace**. Thay đổi quyền trong dashboard local.
- `approval_required` là thao tác đang chờ duyệt: không gửi lại. Sau khi người dùng duyệt, đọc `workbench(operation_id)` để lấy kết quả.
- Không thử đường tool khác để vượt qua từ chối quyền. `CHATGPT_AUTO_APPROVE` không cấp quyền và không che giấu rủi ro trong annotations.
- Chưa có sandbox tiến trình: terminal, Git, GitHub và upstream bị chặn trong chế độ chỉ workspace.
- Review và Undo/Redo theo task tại `/ui/workbench.html`; legacy rewind không được dùng để restore.

## ChatGPT: tránh popup + lỗi "Luôn cho phép phải kết nối lại"

### Cách đúng (làm TRƯỚC khi chat)

1. **Settings → Apps → Connectors** → chọn connector **Codex Local**
2. Đặt quyền app: **Chỉ hỏi trước thay đổi quan trọng** hoặc **Hỏi trước khi thay đổi**
3. Bấm **Refresh** connector (sau mỗi lần update server)
4. Mở chat mới, chọn connector, rồi mới gửi prompt

### KHÔNG bấm "Luôn cho phép" trên popup

Đây là bug/UI ChatGPT: bấm **Luôn cho phép** thường **đóng MCP session** → tunnel log `stream canceled` → phải kết nối lại.

Thay vào đó:
- Bấm **Cho phép một lần** khi cần, hoặc
- Cấu hình quyền ở **Settings → Apps** (bước trên) để ít hỏi hơn

### Lỗi tunnel `stream canceled by remote`

Bình thường khi:
- Server restart (`stop.ps1` / `start.ps1`) trong lúc ChatGPT đang kết nối
- ChatGPT đóng stream SSE sau khi đổi quyền
- Tunnel URL đổi (chạy lại `tunnel.bat` cloudflared) mà chưa update Connector URL

**Fix:** Giữ server + tunnel chạy ổn định, không restart giữa chừng. Nếu restart → Refresh connector + chat mới.

**Khuyến nghị:** Dùng `openai-tunnel.bat` (OpenAI Secure MCP Tunnel) — `tunnel_id` cố định, không cần đổi URL connector mỗi lần.

## Mapping Claude Code ↔ Codex MCP

| Claude Code | Codex MCP | Ghi chú |
|---|---|---|
| `Read` | `read_text_file` | Có `offset`+`limit` (line numbers) |
| `Write` | `write_file` | |
| `Edit` | `edit_file` | Có `replace_all` |
| `MultiEdit` | `multi_edit` | |
| `Glob` | `glob` | Sort theo mtime |
| `Grep` | `grep` | content / files_with_matches / count |
| `LS` | `list_directory` | Có `ignore` globs |
| `Bash` | `run_command` | Lệnh ngắn, chờ xong |
| Background shell | `start_process` + `process_output` | |
| `Rewind` | `rewind` | `list` / `preview` / `restore` — undo file edits qua checkpoint tự động |
| — | `mcp_servers`, `mcp_tools`, `mcp_call` | Gọi MCP server khác trên máy (hub) |
| — | Admin UI `:3001/ui` | Import MCP từ Cursor / Claude Code / OpenCode |
| — | `apply_patch` | Codex/OpenAI style (thêm so với Claude) |
| — | `git_*`, `git_restore` | Git tools riêng (Claude dùng Bash) |
| — | `project_context` | Đọc AGENTS.md / CLAUDE.md |

**Không có trong MCP này** (ChatGPT built-in hoặc MCP khác): `WebSearch`, `WebFetch`, `Task`/subagent, `NotebookEdit`, `LSP`.

## Sửa code — tool nào dùng khi nào

| Việc cần làm | Tool |
|---|---|
| Tìm file theo tên | `glob` |
| Tìm nội dung | `grep` |
| Đọc file | `read_text_file` |
| Liệt kê thư mục | `list_directory` |
| Sửa bằng diff/patch | `apply_patch` (ưu tiên) |
| Sửa nhiều đoạn | `multi_edit` |
| Sửa bằng regex | `replace_regex` |
| Tạo file mới | `write_file` |
| Xóa / đổi tên | `delete_file`, `move_file` |
| Chạy lệnh ngắn | `run_command` |
| Build/test dài | `start_process` → `process_output` |
| Git | `git_status`, `git_diff`, `git_commit`, `git_restore` |
| Restore file từ commit | `git_restore` (không dùng `git_checkout` cho file) |
| Undo edits trong session | `rewind` action `list` → `preview` → `restore` (không track bash) |
| Switch branch | `git_checkout` (chỉ branch) hoặc `git_branch` action `switch` |

## Khi thao tác bị từ chối

Đọc lý do và policy hiện tại bằng `workbench`. Không dùng `run_command` hoặc tool khác để vượt qua từ chối của Workbench hay kiểm tra an toàn của client, kể cả khi response cũ chứa `run_command_fallback`.

Nếu nhận `approval_required`, thông báo người dùng duyệt yêu cầu trong dashboard. Sau đó đọc kết quả bằng `workbench` với `operation_id`; không gửi lại thao tác vì yêu cầu gốc được thực thi khi duyệt.

Nếu nhận `SANDBOX_UNAVAILABLE`, workspace-only không hỗ trợ chạy tiến trình trong bản này. Người dùng có thể tự đổi phạm vi trong dashboard nếu muốn cho phép lệnh theo quyền tài khoản chạy server.

## Format `apply_patch` (Codex-style)

```
@@
-old line to remove
+new line to add
 context line unchanged
```

Hoặc unified diff chuẩn:

```
@@ -10,3 +10,4 @@
 context
-old
+new
```

Tham số: `{ "path": "src/foo.ts", "patch": "...", "dry_run": false }`

Dùng `dry_run: true` để xem diff trước khi ghi.

## Đường dẫn file

- Dùng path tuyệt đối: `C:\Users\...\project\src\file.ts`
- Hoặc relative từ `WORKSPACE_PATH` trong `.env`
- Gọi `list_allowed_directories` nếu bị "Access denied"

## Khởi động server

```powershell
cd codex-mcp-server
.\start.ps1 -Force          # Terminal 1: MCP server
.\openai-tunnel.bat         # Terminal 2: OpenAI tunnel (URL cố định)
```

**Lần đầu:** chạy `.\openai-tunnel-init.bat` → nhập `tunnel_id` + Runtime API key từ [Platform Tunnels](https://platform.openai.com/settings/organization/tunnels).

**ChatGPT:** [Settings → Connectors](https://chatgpt.com/#settings/Connectors) → chọn tunnel (không cần dán URL thủ công).

Tunnel cũ (URL đổi mỗi lần): `.\tunnel.bat` (cloudflared).

Health check: `http://localhost:3000/health` | Tunnel UI: `http://127.0.0.1:8080/ui`

## Troubleshooting

| Lỗi | Cách xử lý |
|---|---|
| Access denied | Kiểm tra path; bật `FULL_DISK_ACCESS=true` |
| Patch context not found | Đọc file trước; thêm context lines (dòng bắt đầu bằng space) |
| ChatGPT hỏi quyền mỗi lần | Kiểm tra quyền connector trong Settings → Apps và policy task trong Workbench; annotations không bỏ qua quyền phía ChatGPT |
| Connection failed | Chạy `.\start.ps1` + tunnel; URL phải HTTPS |
