<script lang="ts">
    import { onMount } from 'svelte';
    import { studioDateString, addStudioDays } from '$lib/utils/studio-time';
    import { analytics } from '$lib/utils/analytics';

    interface StudioClass {
        id: number; start: string; end: string; title: string; instructors: string[];
        booked: number | null; max: number | null;
        bookingOpen: boolean; bookingOpensAt: string | null; bookingUrl: string | null;
    }
    let classes = $state<StudioClass[]>([]);
    let loaded = $state(false);

    const clock = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', hour: '2-digit', minute: '2-digit' });
    const weekday = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', day: '2-digit', month: '2-digit' });
    const opensAt = new Intl.DateTimeFormat('de-DE', { timeZone: 'Europe/Berlin', weekday: 'short', hour: '2-digit', minute: '2-digit' });

    function dayLabel(start: string) {
        const day = studioDateString(new Date(start));
        const today = studioDateString();
        return day === today ? 'Heute' : day === addStudioDays(today, 1) ? 'Morgen' : weekday.format(new Date(start));
    }
    const groups = $derived.by(() => {
        const result: { label: string; items: StudioClass[] }[] = [];
        for (const item of classes) {
            const label = dayLabel(item.start);
            if (result.at(-1)?.label === label) result.at(-1)!.items.push(item);
            else result.push({ label, items: [item] });
        }
        return result;
    });
    // "Trainer" is the booking system's placeholder, not a person.
    const named = (item: StudioClass) => item.instructors.filter(name => name.trim() && name.trim().toLowerCase() !== 'trainer');
    const full = (item: StudioClass) => item.max !== null && item.booked !== null && item.max > 0 && item.booked >= item.max;
    const fill = (item: StudioClass) => item.max ? Math.min(100, Math.round((item.booked ?? 0) / item.max * 100)) : 0;

    async function load() {
        try {
            const response = await fetch('/api/classes');
            if (response.ok) classes = (await response.json()).classes ?? [];
        } catch {
            // The schedule is supplementary; the card simply stays hidden.
        } finally {
            loaded = true;
        }
    }
    onMount(() => {
        void load();
        const interval = setInterval(load, 10 * 60_000);
        return () => clearInterval(interval);
    });
</script>

{#if loaded && classes.length}
    <section class="card" aria-labelledby="classes-title">
        <div class="card-header">
            <h2 id="classes-title" class="card-title">Kurse</h2>
            <span class="hint">Belegung laut Buchungssystem</span>
        </div>
        {#each groups as group (group.label)}
            <h3>{group.label}</h3>
            <ul>
                {#each group.items as item (item.id)}
                    <li>
                        <time datetime={item.start}>{clock.format(new Date(item.start))}<span>–{clock.format(new Date(item.end))}</span></time>
                        <div class="details">
                            <strong>{item.title}</strong>
                            {#if named(item).length}<span class="muted">mit {named(item).join(', ')}</span>{/if}
                        </div>
                        {#if item.max}
                            <div class="spots" title={`${item.booked ?? 0} von ${item.max} Plätzen gebucht`}>
                                <span class="bar"><span style={`width: ${fill(item)}%`} class:full={full(item)}></span></span>
                                <span class="count">{item.booked ?? 0}/{item.max}</span>
                            </div>
                        {/if}
                        <div class="action">
                            {#if full(item)}
                                <span class="muted">Ausgebucht</span>
                            {:else if item.bookingOpen && item.bookingUrl}
                                <a href={item.bookingUrl} target="_blank" rel="noopener noreferrer" onclick={() => analytics.classBooking(item.title)}>Buchen <span aria-hidden="true">↗</span></a>
                            {:else if item.bookingOpensAt}
                                <span class="muted">buchbar ab {opensAt.format(new Date(item.bookingOpensAt)).replace(', ', ' ')}</span>
                            {/if}
                        </div>
                    </li>
                {/each}
            </ul>
        {/each}
    </section>
{/if}

<style>
    .card-title { font-size: 1rem; }
    .hint, .muted { color: var(--text-secondary); font-size: .68rem; }
    h3 { font-size: .7rem; font-weight: 600; color: var(--text-secondary); text-transform: uppercase; letter-spacing: .08em; margin: 10px 0 4px; }
    h3:first-of-type { margin-top: 0; }
    ul { list-style: none; margin: 0; padding: 0; }
    li { display: grid; grid-template-columns: 82px minmax(0, 1fr) 76px 120px; align-items: center; gap: 10px; padding: 7px 0; border-top: 1px solid var(--border-color); font-size: .78rem; }
    li:first-child { border-top: none; }
    time { font-variant-numeric: tabular-nums; font-weight: 600; }
    time span { color: var(--text-secondary); font-weight: 400; }
    .details { display: flex; flex-direction: column; min-width: 0; }
    .details strong { font-weight: 550; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .spots { display: flex; align-items: center; gap: 6px; }
    .bar { flex: 1; height: 4px; border-radius: 2px; background: var(--bg-tertiary); overflow: hidden; }
    .bar span { display: block; height: 100%; background: var(--accent-primary); }
    .bar span.full { background: var(--danger); }
    .count { color: var(--text-secondary); font-size: .68rem; font-variant-numeric: tabular-nums; min-width: 34px; text-align: right; }
    .action { text-align: right; }
    .action a { color: var(--accent-primary); font-weight: 600; font-size: .75rem; text-decoration: none; }
    .action a:hover { text-decoration: underline; }
    .action a:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; border-radius: 3px; }
    @media (max-width: 700px) {
        li { grid-template-columns: 46px minmax(0, 1fr) auto; grid-template-areas: 'time details action' 'time spots action'; row-gap: 3px; font-size: .74rem; }
        time { grid-area: time; align-self: start; }
        time span { display: none; }
        .details { grid-area: details; }
        .spots { grid-area: spots; max-width: 130px; }
        .action { grid-area: action; }
    }
</style>
