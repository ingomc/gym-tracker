<script lang="ts">
    import { onMount } from 'svelte';
    import { studioDateString, addStudioDays } from '$lib/utils/studio-time';

    interface AvailableDate { date: string; count: number; }
    let { selectedDate = null, onSelectDate, onGoToToday }: {
        selectedDate: string | null;
        onSelectDate: (date: string) => void;
        onGoToToday: () => void;
    } = $props();
    let availableDates = $state<AvailableDate[]>([]);
    let showPicker = $state(false);
    let today = $state(studioDateString());
    let month = $state(studioDateString().slice(0, 7));
    let container: HTMLDivElement;
    let trigger: HTMLButtonElement;
    let dateError = $state(false);
    let controller: AbortController | null = null;
    const currentDate = $derived(selectedDate ?? today);
    const maxDate = $derived(addStudioDays(today, 7));
    const available = $derived(new Set(availableDates.map((entry) => entry.date)));
    const dates = $derived([...new Set([...availableDates.map((entry) => entry.date).filter((date) => date < today), ...Array.from({ length: 8 }, (_, index) => addStudioDays(today, index))])].sort());
    const previous = $derived(dates.filter((date) => date < currentDate).at(-1));
    const next = $derived(dates.find((date) => date > currentDate));
    const displayDate = $derived(formatDate(currentDate));
    const days = $derived.by(() => {
        const first = new Date(`${month}-01T12:00:00Z`);
        const offset = (first.getUTCDay() + 6) % 7;
        const start = addStudioDays(`${month}-01`, -offset);
        return Array.from({ length: 42 }, (_, index) => {
            const date = addStudioDays(start, index);
            return { date, day: Number(date.slice(-2)), inMonth: date.startsWith(month), enabled: available.has(date) || (date >= today && date <= maxDate) };
        });
    });
    function formatDate(date: string) {
        return new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', day: 'numeric', month: 'short', year: 'numeric' }).format(new Date(`${date}T12:00:00Z`));
    }
    async function fetchAvailableDates() {
        controller?.abort();
        const active = new AbortController();
        controller = active;
        try {
            const response = await fetch('/api/available-dates', { signal: active.signal });
            if (!response.ok) throw new Error('dates');
            const result = await response.json();
            if (!active.signal.aborted) { availableDates = result.dates; dateError = false; }
        } catch { if (!active.signal.aborted) dateError = true; }
    }
    function close() { showPicker = false; }
    function selectDate(date: string) { showPicker = false; onSelectDate(date); trigger?.focus(); }
    function open() { month = currentDate.slice(0, 7); showPicker = !showPicker; }
    function moveMonth(direction: number) {
        const date = new Date(`${month}-01T12:00:00Z`);
        date.setUTCMonth(date.getUTCMonth() + direction);
        month = date.toISOString().slice(0, 7);
    }
    function calendarKey(event: KeyboardEvent, date: string) {
        const offset = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
        if (!offset) return;
        event.preventDefault();
        const target = addStudioDays(date, offset);
        const button = container.querySelector<HTMLButtonElement>(`[data-date="${target}"]`);
        if (button && !button.disabled) button.focus();
    }
    export function refresh() { today = studioDateString(); void fetchAvailableDates(); }
    export function selectLatestArchive() {
        const latest = availableDates.map((entry) => entry.date).filter((date) => date < today).sort().at(-1);
        if (latest) selectDate(latest);
        else { month = addStudioDays(today, -1).slice(0, 7); showPicker = true; }
    }
    onMount(() => { void fetchAvailableDates(); return () => controller?.abort(); });
</script>

<svelte:window onpointerdown={(event) => { if (showPicker && !container?.contains(event.target as Node)) close(); }} onkeydown={(event) => { if (showPicker && event.key === 'Escape') { close(); trigger?.focus(); } }} />

<div class="date-picker" bind:this={container}>
    <button class="date-step" aria-label="Vorheriger verfügbarer Tag" disabled={!previous} onclick={() => previous && selectDate(previous)}>‹</button>
    <button class="date-label" bind:this={trigger} onclick={open} aria-expanded={showPicker} aria-controls="date-calendar" aria-label={`Datum wählen: ${displayDate}`}>
        <svg aria-hidden="true" width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M3 10h18M8 3v4M16 3v4" /></svg>
        {displayDate}
        <span aria-hidden="true" class="chevron">⌄</span>
    </button>
    <button class="date-step" aria-label="Nächster verfügbarer Tag" disabled={!next} onclick={() => next && selectDate(next)}>›</button>
    {#if showPicker}
        <div id="date-calendar" class="calendar" role="region" aria-label="Datum auswählen">
            <div class="calendar-header">
                <button aria-label="Vorheriger Monat" onclick={() => moveMonth(-1)}>‹</button>
                <strong>{new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', month: 'long', year: 'numeric' }).format(new Date(`${month}-01T12:00:00Z`))}</strong>
                <button aria-label="Nächster Monat" disabled={month >= maxDate.slice(0, 7)} onclick={() => moveMonth(1)}>›</button>
            </div>
            <div class="calendar-grid">
                {#each ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'] as weekday}<span class="weekday">{weekday}</span>{/each}
                {#each days as day}
                    <button class:other={!day.inMonth} class:selected={day.date === currentDate} class:today={day.date === today} class:future={day.date > today && day.enabled}
                        disabled={!day.enabled} data-date={day.date} aria-label={`${formatDate(day.date)}${day.date === today ? ', heute' : day.date > today ? ', Prognose' : ''}`} aria-current={day.date === today ? 'date' : undefined} aria-pressed={day.date === currentDate}
                        onclick={() => selectDate(day.date)} onkeydown={(event) => calendarKey(event, day.date)}>{day.day}</button>
                {/each}
            </div>
            {#if dateError}<p class="calendar-error">Archivdaten konnten nicht geladen werden.</p><button class="retry" onclick={fetchAvailableDates}>Erneut laden</button>{/if}
            <button class="today-button" onclick={() => { close(); today = studioDateString(); onGoToToday(); trigger?.focus(); }}>Zurück zu heute</button>
        </div>
    {/if}
</div>

<style>
    .date-picker { display: flex; align-items: center; position: relative; border: 1px solid var(--border-color); border-radius: 6px; }
    .date-picker button { background: none; border: none; color: var(--text-primary); }
    .date-step { width: 32px; min-height: 32px; font-size: 1.2rem; }
    .date-step:hover:not(:disabled), .date-label:hover { background: var(--bg-tertiary); }
    .date-step:disabled { opacity: .25; }
    .date-label { display: flex; align-items: center; justify-content: center; gap: 7px; min-height: 32px; font-size: .72rem; padding: 0 8px; }
    .date-label svg, .chevron { color: var(--text-secondary); }
    .calendar { position: absolute; z-index: 50; top: calc(100% + 7px); right: 0; width: 290px; padding: 12px; border: 1px solid #414854; border-radius: 9px; box-shadow: var(--shadow-lg); background: #20242d; }
    .calendar-header { display: flex; align-items: center; justify-content: space-between; font-size: .82rem; margin-bottom: 10px; }
    .calendar-header button { min-width: 34px; min-height: 34px; font-size: 1.25rem; }
    .calendar-header button:disabled { opacity: .2; }
    .calendar-grid { display: grid; grid-template-columns: repeat(7, 1fr); gap: 3px; }
    .weekday { text-align: center; color: var(--text-secondary); font-size: .7rem; margin-bottom: 6px; }
    .calendar-grid button { height: 34px; border-radius: 7px; font-size: .78rem; }
    .calendar-grid button:hover:not(:disabled) { background: #353d4b; }
    .calendar-grid button.future { color: #c2c9d6; }
    .calendar-grid button.today { outline: 1px solid #a5adbd80; outline-offset: -2px; }
    .calendar-grid button.selected { background: #d5d9e2; color: #161920; font-weight: 700; }
    .calendar-grid button:disabled { opacity: .23; } .calendar-grid button.other { opacity: .4; }
    .calendar-error { color: var(--warning); font-size: .65rem; margin: 10px 0; } .retry { font-size: .7rem; text-decoration: underline; }
    .date-picker .today-button { border-top: 1px solid var(--border-color); color: var(--text-primary); width: 100%; padding: 9px 0 0; margin-top: 10px; font-size: .74rem; }
    @media (max-width: 700px) { .date-label { flex: 1; } .date-picker { width: 100%; } .calendar { right: 0; width: min(290px, calc(100vw - 46px)); } }
</style>
