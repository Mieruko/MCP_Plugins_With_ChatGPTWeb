import { api } from './workbench/api.js';
const $ = selector => document.querySelector(selector);
const status = $('#status');
const profileTask = $('#profile-task');
const setupButton = $('#setup-browser');
let opening = false, computerEnabled = false, activeBrowser = false;
let lastProfiles = '', lastSessions = '', lastJobs = '', noticeSource = '';
const labels = { ready: 'Sẵn sàng', busy: 'Đang thao tác', stopping: 'Đang dừng', created: 'Đã tạo', running: 'Đang chạy', succeeded: 'Hoàn tất', completed: 'Hoàn tất', failed: 'Thất bại', cancelled: 'Đã hủy', disconnected: 'Mất kết nối', unknown: 'Chưa xác định', waiting_input: 'Chờ nhập liệu', waiting_user: 'Chờ bạn xử lý', queued: 'Đang chờ', paused: 'Tạm dừng' };
const formatDate = value => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Chưa có thời gian' : date.toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
};
function notice(message = '', source = 'action') { status.textContent = message; status.hidden = !message; noticeSource = source; }
function badge(element, text, tone = '') { element.textContent = text; element.dataset.tone = tone; }
function updateSetupButton() {
  setupButton.disabled = opening || !computerEnabled || !profileTask.value || activeBrowser;
  setupButton.textContent = opening ? 'Đang mở Chrome…' : activeBrowser ? 'Chrome đang mở' : 'Mở Chrome';
}
profileTask.onchange = updateSetupButton;
setupButton.onclick = async () => {
  if (setupButton.disabled) return;
  opening = true; updateSetupButton(); notice();
  try {
    const result = await api('/api/workbench/computer/setup', { method: 'POST', body: { task_id: profileTask.value } });
    if (result.isError || result.status === 'approval_required') throw new Error(result.error || result.message || 'Yêu cầu đang chờ duyệt trong Workbench.');
    await refresh();
  } catch (error) { notice(error.message); }
  finally { opening = false; updateSetupButton(); }
};
function element(tag, className, text) {
  const node = document.createElement(tag); node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function card(title, state, detail) {
  const item = element('article', 'item-card');
  const heading = element('div', 'card-heading');
  const pill = element('span', 'badge');
  badge(pill, labels[state] || state, ['ready', 'running', 'succeeded', 'completed'].includes(state) ? 'good' : ['disconnected', 'failed', 'unknown'].includes(state) ? 'warning' : '');
  heading.append(element('strong', '', title), pill);
  item.append(heading, element('p', 'card-meta', detail));
  return item;
}
function empty(container, title, description) {
  const box = element('div', 'empty-state');
  box.append(element('strong', '', title), element('p', '', description)); container.append(box);
}
function renderSessions(items) {
  const container = $('#sessions'); container.replaceChildren();
  $('#session-count').textContent = items.length;
  for (const session of items) {
    const browser = session.backend === 'browser';
    const item = card(browser ? 'Chrome dùng chung' : 'Windows', session.desktop_paused ? 'Chờ phiên Windows kết thúc' : session.manual_setup ? 'Thiết lập thủ công' : session.state,
      `${session.controller_count ?? 1} chat · ${session.task_count ?? 1} task · Hết hạn ${formatDate(session.expires_at)}`);
    const stop = element('button', 'danger', browser ? (session.manual_setup ? 'Lưu & đóng Chrome' : 'Đóng Chrome cho tất cả chat') : 'Dừng phiên Windows');
    stop.type = 'button';
    stop.onclick = async () => {
      stop.disabled = true; notice();
      try { await api(`/api/workbench/computer/sessions/${encodeURIComponent(session.session_id)}/stop`, { method: 'POST', body: {} }); await refresh(); }
      catch (error) { notice(error.message); stop.disabled = false; }
    };
    item.append(stop); container.append(item);
  }
  if (!items.length) empty(container, 'Chưa có phiên điều khiển', 'Mở Chrome ở phía trên để đăng nhập và bắt đầu công việc.');
}
function renderJobs(items) {
  const container = $('#jobs'); container.replaceChildren(); $('#job-count').textContent = items.length;
  for (const job of items) {
    const name = { colab: 'Google Colab', facebook: 'Facebook', browser: 'Trình duyệt' }[job.workflow] || job.workflow;
    const item = card(name, job.state, `${job.monitoring ? 'Đang theo dõi · ' : ''}Cập nhật ${formatDate(job.updated_at)}`);
    const detail = element('details', ''); detail.append(element('summary', '', 'Xem chi tiết'));
    detail.append(element('code', '', job.expected_url || 'Chưa có địa chỉ'), element('p', 'card-meta', `ID: ${job.id}`));
    item.append(detail); container.append(item);
  }
  if (!items.length) empty(container, 'Chưa có công việc', 'Các tác vụ được tạo qua ChatGPT sẽ xuất hiện tại đây.');
}
async function refresh() {
  try {
    const data = await api('/api/workbench/computer');
    if (noticeSource === 'connection') notice();
    computerEnabled = Boolean(data.enabled);
    badge($('#browser-status'), computerEnabled ? 'Chrome · đã bật' : 'Chrome · chưa bật', computerEnabled ? 'good' : '');
    badge($('#windows-status'), data.windows_enabled ? 'Windows · đã bật' : 'Windows · chưa bật', data.windows_enabled ? 'good' : '');
    const profiles = data.profiles || [], sessions = data.sessions || [], jobs = data.jobs || [];
    $('#shared-profile').textContent = data.shared_profile?.path || profiles[0]?.path || 'Chưa có thông tin hồ sơ chung.';
    const profileKey = JSON.stringify(profiles);
    if (profileKey !== lastProfiles) {
      const selected = profileTask.value;
      profileTask.replaceChildren(...profiles.map(profile => {
        const option = document.createElement('option'); option.value = profile.task_id;
        option.textContent = `${profile.title} · ${profile.task_id.slice(0, 8)}`; return option;
      }));
      if (!profiles.length) { const option = document.createElement('option'); option.value = ''; option.textContent = 'Chưa có task khả dụng'; profileTask.append(option); }
      if ([...profileTask.options].some(option => option.value === selected)) profileTask.value = selected;
      lastProfiles = profileKey;
    }
    activeBrowser = sessions.some(session => session.backend === 'browser');
    badge($('#chrome-state'), activeBrowser ? 'Đang mở' : 'Chưa mở', activeBrowser ? 'good' : '');
    updateSetupButton();
    const sessionKey = JSON.stringify(sessions), jobKey = JSON.stringify(jobs);
    if (sessionKey !== lastSessions) { renderSessions(sessions); lastSessions = sessionKey; }
    if (jobKey !== lastJobs) { renderJobs(jobs); lastJobs = jobKey; }
    $('#last-updated').textContent = `Cập nhật lúc ${new Date().toLocaleTimeString('vi-VN')} · Tự làm mới mỗi 5 giây`;
  } catch (error) {
    computerEnabled = false; updateSetupButton();
    badge($('#browser-status'), 'Không kết nối', 'warning'); badge($('#windows-status'), 'Chưa xác định');
    badge($('#chrome-state'), 'Chưa xác định');
    $('#last-updated').textContent = 'Mất kết nối · Đang thử lại';
    notice(`Không đọc được trạng thái: ${error.message}. Mở Workbench để kiểm tra kết nối.`, 'connection');
  }
}
async function poll() { await refresh(); setTimeout(poll, 5000); }
void poll();
