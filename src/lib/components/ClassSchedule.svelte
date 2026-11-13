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
        return day === today ? 'Heute' : day === addStudioDays(today, 1) ? 'Morgen' : weekday.format(new Date(start)).replace(',', '');
    }
    // "Trainer" is the booking system's placeholder, not a person.
    const named = (item: StudioClass) => item.instructors.filter(name => name.trim() && name.trim().toLowerCase() !== 'trainer');
    const free = (item: StudioClass) => item.max !== null && item.booked !== null ? Math.max(0, item.max - item.booked) : null;
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
            <span class="hint">{classes.length} {classes.length === 1 ? 'Termin' : 'Termine'} in den nächsten Tagen</span>
        </div>
        <ul class="tiles">
            {#each classes as item (item.id)}
                {@const left = free(item)}
                {@const bookable = item.bookingOpen && item.bookingUrl && left !== 0}
                <li class="tile" class:soon={dayLabel(item.start) === 'Heute'} style={`--fill: ${fill(item)}%`}>
                    <div class="when">
                        <span class="day">{dayLabel(item.start)}</span>
                        <time datetime={item.start}>{clock.format(new Date(item.start))}</time>
                    </div>
                    <strong class="title">{item.title}</strong>
                    {#if named(item).length}<span class="muted">mit {named(item).join(', ')}</span>{/if}
                    <div class="footer">
                        <span class="spots" class:full={left === 0}>
                            {left === null ? '' : left === 0 ? 'Ausgebucht' : `${left} ${left === 1 ? 'Platz' : 'Plätze'} frei`}
                        </span>
                        {#if bookable}
                            <a href={item.bookingUrl} target="_blank" rel="noopener noreferrer" onclick={() => analytics.classBooking(item.title)}
                               aria-label={`${item.title} am ${dayLabel(item.start)} um ${clock.format(new Date(item.start))} buchen`}>Buchen <span aria-hidden="true">↗</span></a>
                        {:else if item.bookingOpensAt && left !== 0}
                            <span class="muted">ab {opensAt.format(new Date(item.bookingOpensAt)).replace(', ', ' ')}</span>
                        {/if}
                    </div>
                    {#if item.max}<span class="meter" aria-hidden="true"></span>{/if}
                </li>
            {/each}
        </ul>
    </section>
{/if}

<style>
    .card-title { font-size: 1rem; }
    .hint, .muted { color: var(--text-secondary); font-size: .66rem; }
    .tiles { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 8px; }
    .tile { position: relative; display: flex; flex-direction: column; gap: 3px; min-width: 0; padding: 11px 12px 13px; border: 1px solid var(--border-color); border-radius: var(--radius-sm); background: var(--bg-primary); overflow: hidden; }
    .tile.soon { border-color: color-mix(in srgb, var(--accent-primary) 45%, var(--border-color)); }
    .when { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; margin-bottom: 2px; }
    .day { color: var(--text-secondary); font-size: .64rem; font-weight: 600; text-transform: uppercase; letter-spacing: .08em; }
    .soon .day { color: var(--accent-primary); }
    time { font-size: .95rem; font-weight: 650; font-variant-numeric: tabular-nums; letter-spacing: -.01em; }
    .title { font-size: .8rem; font-weight: 550; line-height: 1.25; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .footer { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-top: auto; padding-top: 8px; font-size: .7rem; }
    .spots { color: var(--text-secondary); font-variant-numeric: tabular-nums; }
    .spots.full { color: var(--danger); }
    a { color: var(--accent-primary); font-weight: 600; text-decoration: none; white-space: nowrap; }
    a:hover { text-decoration: underline; }
    a:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; border-radius: 3px; }
    /* Booked share as a hairline along the tile's bottom edge. */
    .meter { position: absolute; left: 0; right: 0; bottom: 0; height: 3px; background: var(--bg-tertiary); }
    .meter::after { content: ''; position: absolute; inset: 0 auto 0 0; width: var(--fill); background: var(--accent-primary); }
    @media (max-width: 700px) {
        .tiles { display: flex; overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none; margin: 0 -12px; padding: 0 12px 2px; scroll-padding: 0 12px; }
        .tiles::-webkit-scrollbar { display: none; }
        .tile { flex: 0 0 min(64%, 210px); scroll-snap-align: start; }
    }
</style>
