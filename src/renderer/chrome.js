const chips = document.getElementById('chips');
const form = document.getElementById('add-form');
const addBtn = document.getElementById('add');
const nameInput = document.getElementById('add-name');
const urlInput = document.getElementById('add-url');
const error = document.getElementById('add-error');
const modal = document.getElementById('modal');
const modalSlot = document.getElementById('modal-slot');
const modalRisk = document.getElementById('modal-risk');
const modalConsent = document.getElementById('modal-consent');
const modalMode = document.getElementById('modal-mode');
const modalInterval = document.getElementById('modal-interval');
const modalJitter = document.getElementById('modal-jitter');
const modalMax = document.getElementById('modal-max');
const modalError = document.getElementById('modal-error');
const modalSave = document.getElementById('modal-save');
const stopAllBtn = document.getElementById('stop-all');
let editingSlot = null;

window.launcher.riskText().then((text) => {
  modalRisk.textContent = text || '';
});

document.getElementById('modal-cancel').addEventListener('click', closeModal);
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});
modalSave.addEventListener('click', async () => {
  modalError.textContent = '';
  const config = {
    enabled: modalConsent.checked,
    consent: modalConsent.checked,
    mode: modalMode.value,
    intervalMs: Number(modalInterval.value),
    jitterMs: Number(modalJitter.value),
    maxPerMin: Number(modalMax.value),
  };
  modalSave.disabled = true;
  const res = await window.launcher.setAutomation(editingSlot.id, config);
  modalSave.disabled = false;
  if (!res?.ok) {
    modalError.textContent = res?.error || 'Falha ao salvar';
    return;
  }
  closeModal();
});

stopAllBtn.addEventListener('click', async () => {
  await window.launcher.stopAllAutomation();
});

function openModal(slot) {
  editingSlot = slot;
  modalSlot.textContent = `Sessão: ${slot.name}`;
  modalConsent.checked = slot.automation?.enabled === true;
  modalMode.value = slot.automation?.mode ?? 'fixed';
  modalInterval.value = slot.automation?.intervalMs ?? 2000;
  modalJitter.value = slot.automation?.jitterMs ?? 800;
  modalMax.value = slot.automation?.maxPerMin ?? 20;
  modalError.textContent = '';
  modal.hidden = false;
}

function closeModal() {
  modal.hidden = true;
  editingSlot = null;
}

addBtn.addEventListener('click', () => {
  form.hidden = false;
  addBtn.hidden = true;
  nameInput.focus();
});
document.getElementById('add-cancel').addEventListener('click', closeForm);
form.addEventListener('submit', async (e) => {
  e.preventDefault();
  error.textContent = '';
  urlInput.style.borderColor = '';
  try {
    await window.launcher.addSlot(nameInput.value.trim(), urlInput.value.trim());
  } catch (err) {
    error.textContent = err.message || 'Falha ao criar sessao';
    urlInput.style.borderColor = '#ff6b6b';
    return;
  }
  nameInput.value = '';
  closeForm();
});

function closeForm() {
  form.hidden = true;
  addBtn.hidden = false;
  urlInput.style.borderColor = '';
}

document.querySelectorAll('#layout-btns button').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#layout-btns button').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    window.launcher.setLayout(Number(btn.dataset.cols));
  });
});

window.launcher.onState((slots) => {
  chips.replaceChildren();
  if (slots.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'empty-hint';
    hint.textContent = 'Nenhuma sessão — clique em +';
    chips.appendChild(hint);
  }
  for (const s of slots) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    const dot = document.createElement('i');
    dot.className = s.loggedIn ? 'dot on' : 'dot';
    dot.title = s.loggedIn ? 'Sessao com login ativo' : 'Sem login';
    chip.appendChild(dot);
    const label = document.createElement('span');
    label.textContent = s.name;
    chip.appendChild(label);
    chip.addEventListener('click', () => window.launcher.focusSlot(s.id));
    const x = document.createElement('span');
    x.className = 'x';
    x.textContent = '×';
    x.title = 'Fechar sessao';
    x.addEventListener('click', (e) => {
      e.stopPropagation();
      window.launcher.removeSlot(s.id);
    });
    chip.appendChild(x);
    const auto = document.createElement('span');
    auto.className = `auto${s.automation?.enabled ? ' on' : ''}`;
    auto.textContent = 'AUTO';
    auto.dataset.state = s.autoState ?? 'idle';
    auto.title = s.automation?.enabled
      ? `Automacao ativa (${s.automation.mode}) - estado: ${s.autoState ?? '?'} - ${s.autoThrows ?? 0} lancamentos`
      : 'Configurar automacao de lancamentos';
    auto.addEventListener('click', (e) => {
      e.stopPropagation();
      openModal(s);
    });
    chip.appendChild(auto);
    chips.appendChild(chip);
  }
  const anyAuto = slots.some((s) => s.automation?.enabled);
  stopAllBtn.hidden = !anyAuto;
});

const hint = document.createElement('span');
hint.className = 'empty-hint';
hint.textContent = 'Carregando…';
chips.appendChild(hint);
