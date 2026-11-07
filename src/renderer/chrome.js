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
const modalExitEco = document.getElementById('modal-exit-eco');
const modalMode = document.getElementById('modal-mode');
const modalInterval = document.getElementById('modal-interval');
const modalJitter = document.getElementById('modal-jitter');
const modalMax = document.getElementById('modal-max');
const modalError = document.getElementById('modal-error');
const modalSave = document.getElementById('modal-save');
const stopAllBtn = document.getElementById('stop-all');
const closePopupsBtn = document.getElementById('close-popups');
const diagBtn = document.getElementById('diagnostics');
const diagStatus = document.getElementById('diag-status');
let editingSlot = null;
let riskReady = false;

modalSave.disabled = true;
window.launcher
  .riskText()
  .then((text) => {
    modalRisk.textContent = text || '';
    riskReady = Boolean(text);
  })
  .catch(() => {
    riskReady = false;
  })
  .finally(() => {
    modalSave.disabled = !riskReady;
    modalError.textContent = riskReady ? '' : 'Nao foi possivel carregar o aviso de risco';
  });

document.getElementById('modal-cancel').addEventListener('click', closeModal);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !modal.hidden) closeModal();
  else if (e.key === 'Escape' && !closePopupsBtn.hidden) window.launcher.closePopups();
});
modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});
modalSave.addEventListener('click', async () => {
  modalError.textContent = '';
  if (!modalConsent.checked) {
    if (editingSlot?.automation?.enabled) {
      modalSave.disabled = true;
      try {
        await disableSlotAutomation(editingSlot);
        closeModal();
      } finally {
        modalSave.disabled = false;
      }
      return;
    }
    modalError.textContent = 'Confirme o aviso de risco para ativar';
    return;
  }
  if (!riskReady) {
    modalError.textContent = 'Aviso de risco indisponivel';
    return;
  }
  const config = {
    enabled: true,
    consent: true,
    exitEconomy: modalExitEco.checked,
    mode: modalMode.value,
    intervalMs: Number(modalInterval.value),
    jitterMs: Number(modalJitter.value),
    maxPerMin: Number(modalMax.value),
  };
  modalSave.disabled = true;
  try {
    const res = await window.launcher.setAutomation(editingSlot.id, config);
    if (!res?.ok) {
      modalError.textContent = res?.error || 'Falha ao salvar';
      return;
    }
    closeModal();
  } catch (err) {
    modalError.textContent = err?.message ?? 'Falha ao salvar';
  } finally {
    modalSave.disabled = false;
  }
});

function disableSlotAutomation(slot) {
  return window.launcher.setAutomation(slot.id, { ...slot.automation, enabled: false, consent: false });
}

stopAllBtn.addEventListener('click', async () => {
  await window.launcher.stopAllAutomation();
});

closePopupsBtn.addEventListener('click', async () => {
  await window.launcher.closePopups();
});

diagBtn.addEventListener('click', async () => {
  diagBtn.disabled = true;
  diagStatus.textContent = 'coletando…';
  try {
    const res = await window.launcher.runDiagnostics();
    diagStatus.textContent = res?.ok ? `salvo em ${res.file}` : 'falhou';
  } catch {
    diagStatus.textContent = 'falhou';
  } finally {
    diagBtn.disabled = false;
  }
});

function openModal(slot) {
  editingSlot = slot;
  modalSlot.textContent = `Sessão: ${slot.name}`;
  modalConsent.checked = slot.automation?.enabled === true;
  modalExitEco.checked = slot.automation?.exitEconomy !== false;
  modalMode.value = slot.automation?.mode ?? 'fixed';
  modalInterval.value = slot.automation?.intervalMs ?? 2000;
  modalJitter.value = slot.automation?.jitterMs ?? 800;
  modalMax.value = slot.automation?.maxPerMin ?? 20;
  modalError.textContent = slot.autoState === 'captured' && !slot.automation?.enabled
    ? 'A automacao parou ao capturar. Marque o aviso para ativar de novo.'
    : '';
  modal.hidden = false;
  window.launcher.setViewsVisible(false);
  (modalConsent.checked ? modalSave : modalConsent).focus();
}

function closeModal() {
  modal.hidden = true;
  editingSlot = null;
  window.launcher.setViewsVisible(true);
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

const chipViews = new Map();
const autoStateLabel = {
  starting: 'iniciando',
  clicking: 'lançando',
  paused: 'pausado',
  'waiting-button': 'sem alvo na cena',
  'rate-limited': 'no limite por minuto',
  'economy-mode': 'Modo Economia (o jogo farma sozinho)',
  'exiting-economy': 'saindo do Modo Economia',
  'session-taken': 'sessão tomada em outra aba/dispositivo',
  captured: 'parou: capturou',
  error: 'erro',
};

function autoTitle(s) {
  const enabled = s.automation?.enabled === true;
  if (!enabled && s.autoState === 'captured') return 'Parou ao capturar — clique para reativar';
  if (!enabled) return 'Configurar automacao de lancamentos';
  const parts = [`Automacao ativa (${s.automation.mode})`, autoStateLabel[s.autoState] ?? 'iniciando', `${s.autoThrows ?? 0} lancamentos`];
  const age = s.autoLastTick ? Math.round((Date.now() - s.autoLastTick) / 1000) : null;
  if (age !== null && age > 20) parts.push(`SEM TICKS ha ${age}s`);
  else if (age !== null) parts.push(`ultimo tick ha ${age}s`);
  return parts.join(' - ');
}

function createChip() {
  const chip = document.createElement('span');
  chip.className = 'chip';
  const dot = document.createElement('i');
  dot.className = 'dot';
  chip.appendChild(dot);
  const label = document.createElement('span');
  chip.appendChild(label);
  const x = document.createElement('span');
  x.className = 'x';
  x.textContent = '×';
  x.title = 'Fechar sessao';
  chip.appendChild(x);
  const auto = document.createElement('button');
  auto.type = 'button';
  auto.textContent = 'AUTO';
  chip.appendChild(auto);
  const view = { chip, dot, label, auto, slot: null };
  chip.addEventListener('click', () => view.slot && window.launcher.focusSlot(view.slot.id));
  x.addEventListener('click', (e) => {
    e.stopPropagation();
    if (view.slot) window.launcher.removeSlot(view.slot.id);
  });
  auto.addEventListener('click', (e) => {
    e.stopPropagation();
    if (view.slot) openModal(view.slot);
  });
  return view;
}

function updateChip(view, s) {
  view.slot = s;
  view.dot.className = s.loggedIn ? 'dot on' : 'dot';
  view.dot.title = s.loggedIn ? 'Sessao com login ativo' : 'Sem login';
  view.label.textContent = s.name;
  const enabled = s.automation?.enabled === true;
  view.auto.className = `auto${enabled ? ' on' : ''}`;
  view.auto.dataset.state = s.autoState ?? 'idle';
  const age = enabled && s.autoLastTick ? Date.now() - s.autoLastTick : null;
  view.auto.dataset.stalled = age !== null && age > 20000 ? 'true' : 'false';
  view.auto.title = autoTitle(s);
}

window.launcher.onState((slots) => {
  const ids = new Set(slots.map((s) => s.id));
  for (const [id, view] of chipViews) {
    if (ids.has(id)) continue;
    view.chip.remove();
    chipViews.delete(id);
  }
  for (const el of chips.querySelectorAll('.empty-hint')) el.remove();
  if (slots.length === 0) {
    const hint = document.createElement('span');
    hint.className = 'empty-hint';
    hint.textContent = 'Nenhuma sessão — clique em +';
    chips.appendChild(hint);
  }
  for (const s of slots) {
    let view = chipViews.get(s.id);
    if (!view) {
      view = createChip();
      chipViews.set(s.id, view);
      chips.appendChild(view.chip);
    }
    updateChip(view, s);
  }
  const anyAuto = slots.some((s) => s.automation?.enabled);
  stopAllBtn.hidden = !anyAuto;
  const popups = slots.reduce((n, s) => n + (s.popups ?? 0), 0);
  closePopupsBtn.hidden = popups === 0;
});

setInterval(() => {
  for (const view of chipViews.values()) if (view.slot) updateChip(view, view.slot);
}, 1000);

const hint = document.createElement('span');
hint.className = 'empty-hint';
hint.textContent = 'Carregando…';
chips.appendChild(hint);
