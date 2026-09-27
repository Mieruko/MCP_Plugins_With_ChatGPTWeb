import { api } from './workbench/api.js';
const status = document.querySelector('#status');
const profileTask = document.querySelector('#profile-task');
const setupButton = document.querySelector('#setup-browser');
let opening = false;
setupButton.onclick = async () => {
  if (!profileTask.value || opening) return;
  opening = true; setupButton.disabled = true;
  try {
    const result = await api('/api/workbench/computer/setup', { method: 'POST', body: { task_id: profileTask.value } });
    if (result.isError || result.status === 'approval_required') throw new Error(result.error || result.message || 'Không thể mở: kiểm tra policy/approval trong Workbench.');
    await refresh();
  } catch (error) { status.textContent = error.message; }
  finally { opening = false; setupButton.disabled = !profileTask.value; }
};
function card(title, detail) {
  const article = document.createElement('article');
  const heading = document.createElement('strong'); heading.textContent = title;
  const text = document.createElement('small'); text.textContent = detail;
  article.append(heading, text); return article;
}
async function refresh() {
  try {
    const data = await api('/api/workbench/computer');
    status.textContent = data.enabled ? `Đã bật · Windows ${data.windows_enabled ? 'đã bật' : 'chưa bật'}` : 'Computer Use chưa được bật trong cấu hình server.';
    const selected = profileTask.value;
    profileTask.replaceChildren(...(data.profiles || []).map(profile => {
      const option = document.createElement('option'); option.value = profile.task_id;
      option.textContent = `${profile.title} · ${profile.task_id.slice(0, 8)}`;
      return option;
    }));
    if ([...profileTask.options].some(option => option.value === selected)) profileTask.value = selected;
    setupButton.disabled = opening || !data.enabled || !profileTask.value;
    const sessions = document.querySelector('#sessions'); sessions.replaceChildren();
    for (const session of data.sessions) {
      const item = card(`${session.backend} · ${session.manual_setup ? 'Đang thiết lập thủ công' : session.state}`, `Task: ${session.task_id} · Owner: ${session.owner} · Hết hạn: ${new Date(session.expires_at).toLocaleString()}${session.profile_path ? ` · Hồ sơ: ${session.profile_path}` : ''}`);
      const stop = document.createElement('button'); stop.textContent = session.manual_setup ? 'Lưu và đóng trình duyệt' : 'Dừng điều khiển';
      stop.onclick = async () => {
        stop.disabled = true;
        try { await api(`/api/workbench/computer/sessions/${encodeURIComponent(session.session_id)}/stop`, { method: 'POST', body: {} }); await refresh(); }
        catch (error) { status.textContent = error.message; stop.disabled = false; }
      };
      item.append(stop); sessions.append(item);
    }
    if (!data.sessions.length) sessions.textContent = 'Không có phiên đang mở.';
    const jobs = document.querySelector('#jobs'); jobs.replaceChildren();
    for (const job of data.jobs) jobs.append(card(`${job.workflow} · ${job.state}${job.monitoring ? ' · đang theo dõi' : ''}`, `${job.expected_url} · ${new Date(job.updated_at).toLocaleString()} · ${job.id}`));
    if (!data.jobs.length) jobs.textContent = 'Chưa có công việc.';
  } catch (error) { status.textContent = `Không đọc được trạng thái: ${error.message}. Mở Workbench để kiểm tra kết nối.`; }
}
async function poll() { await refresh(); setTimeout(poll, 5000); }
void poll();
