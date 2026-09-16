import { api } from './api.js';
import { currentExperience, currentWorkspace, isBasic, state } from './state.js';
import { $, el, setStatus } from './dom.js';
import { hasUnsavedEditorChanges } from './editor.js';

let refresh;
let writerBusy = false;
let experienceStatus = null;

function showError(id, error) {
  $(id).textContent = error.message;
  $(id).hidden = false;
}

export function renderExperience() {
  const basic = isBasic();
  const workspace = currentWorkspace();
  const view = currentExperience();
  document.body.dataset.experience = basic ? 'basic' : 'advanced';
  $('experience-button').textContent = basic ? 'Basic' : 'Advanced';
  $('experience-button').disabled = !workspace;
  $('settings-experience-summary').textContent = basic ? 'Basic · Recommended · one project, simple review' : 'Advanced · tasks, worktrees and agents';
  $('workspace-settings-experience').disabled = !workspace;
  $('context-heading').textContent = basic ? 'Projects' : 'Workspace & tasks';
  $('context-kicker').textContent = basic ? 'PROJECT' : 'WORKSPACE CONTEXT';
  $('context-project-label').textContent = basic ? 'Project' : 'Workspace';
  $('workspace-review-kicker').textContent = basic ? 'RECENT WORK' : 'WORKSPACE REVIEW';
  $('review-center-recent-heading').textContent = basic ? 'RECENT WORK' : 'RECENT AGENT WORK';
  $('history-operations-label').textContent = basic ? 'RECENT WORK' : 'OPERATIONS';
  $('review-center-heading').textContent = basic ? 'Review changes' : 'Review Center';
  $('review-center-kicker').textContent = basic ? 'PROJECT' : 'WORKSPACE REVIEW';
  $('policy-auto-label').textContent = 'Approve for me';
  $('policy-full-label').textContent = 'Full access';
  $('approve-operation').textContent = basic ? 'Allow once' : 'Approve once';
  if (basic) state.agentFilter = 'all';

  const sessions = view?.sessions || [];
  const writer = sessions.find(session => session.isWriter);
  $('writer-summary').textContent = view?.writer
    ? `${writer?.label || 'Previous conversation'} controls changes${writer?.closed ? ' · disconnected' : ''}`
    : 'Ready for ChatGPT';
  $('writer-description').textContent = view?.writer
    ? 'Other conversations can read. Choose a conversation below to transfer write control.'
    : 'The first edit takes control. Other conversations can still read.';
  const select = $('writer-session');
  const previous = select.value;
  const open = sessions.filter(session => !session.closed);
  select.replaceChildren(...open.map(session => Object.assign(document.createElement('option'), {
    value: session.sessionId, textContent: `${session.label}${session.isWriter ? ' · controls changes' : ' · read only'}`,
  })));
  if (!open.length) select.append(Object.assign(document.createElement('option'), { value: '', textContent: 'Connect a ChatGPT conversation' }));
  if (open.some(session => session.sessionId === previous)) select.value = previous;
  else if (writer && !writer.closed) select.value = writer.sessionId;
  select.disabled = !open.length || writerBusy;
  updateWriterButton();
}

function updateWriterButton() {
  const view = currentExperience();
  const busy = Boolean(view?.runningProcesses || view?.previewLeased);
  $('writer-take-control').disabled = writerBusy || busy || !$('writer-session').value
    || $('writer-session').value === view?.writer?.sessionId;
  $('writer-runtime-note').hidden = !busy;
}

async function openExperience() {
  if (!currentWorkspace()) return;
  $('experience-error').hidden = true;
  $('experience-dialog').showModal();
  $('experience-apply').disabled = true;
  try {
    const workspaceId = state.workspaceId;
    const view = await api(`/api/workbench/workspaces/${workspaceId}/experience`);
    if (workspaceId !== state.workspaceId) return;
    experienceStatus = view;
    state.data.experiences[workspaceId] = view;
    const basic = document.querySelector('input[name="experience"][value="basic"]');
    basic.disabled = false;
    document.querySelector(`input[name="experience"][value="${view.mode}"]`).checked = true;
    $('experience-blockers').replaceChildren(...view.blockers.map(item => el('li', item.message)));
    $('experience-blocked').hidden = !view.blockers.length;
    updateExperienceApplyButton();
  } catch (error) { showError('experience-error', error); }
}

function updateExperienceApplyButton() {
  const selected = document.querySelector('input[name="experience"]:checked')?.value;
  const blocked = selected === 'basic' && experienceStatus?.mode !== 'basic' && !experienceStatus?.canSwitchToBasic;
  $('experience-apply').disabled = Boolean(blocked);
  $('experience-apply').textContent = blocked ? 'Resolve blockers first' : 'Apply experience';
}

export function setupExperience(onRefresh) {
  refresh = onRefresh;
  $('experience-button').onclick = () => void openExperience();
  document.querySelectorAll('input[name="experience"]').forEach(input => {
    input.onchange = updateExperienceApplyButton;
  });
  $('workspace-settings-experience').onclick = () => {
    $('workspace-settings-dialog').close();
    void openExperience();
  };
  $('experience-open-tasks').onclick = () => {
    $('experience-dialog').close();
    $('context-dialog').showModal();
  };
  $('experience-apply').onclick = () => void (async () => {
    const mode = document.querySelector('input[name="experience"]:checked')?.value;
    if (!mode || !state.workspaceId) return;
    $('experience-apply').disabled = true;
    $('experience-error').hidden = true;
    try {
      if (mode === 'basic' && currentExperience()?.basicTaskId !== state.taskId && hasUnsavedEditorChanges()) {
        throw new Error('Save your open files before switching to the Basic project.');
      }
      await api(`/api/workbench/workspaces/${state.workspaceId}/experience`, { method: 'PUT', body: { mode } });
      $('experience-dialog').close();
      await refresh();
      setStatus(`${mode === 'basic' ? 'Basic' : 'Advanced'} experience enabled`);
    } catch (error) { showError('experience-error', error); }
    finally { updateExperienceApplyButton(); }
  })();
  $('writer-session').onchange = updateWriterButton;
  $('writer-take-control').onclick = () => void (async () => {
    if (writerBusy) return;
    writerBusy = true;
    updateWriterButton();
    $('writer-error').hidden = true;
    try {
      await api(`/api/workbench/workspaces/${state.workspaceId}/writer`, { method: 'POST', body: {
        sessionId: $('writer-session').value, expectedSessionId: currentExperience()?.writer?.sessionId || null,
      } });
      await refresh();
      setStatus('Write control transferred. The selected conversation can retry its request.');
    } catch (error) { showError('writer-error', error); }
    finally { writerBusy = false; renderExperience(); }
  })();
}
