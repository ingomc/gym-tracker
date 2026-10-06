<script lang="ts">
    import { onMount } from 'svelte';
    import CurrentUtilization from '$lib/components/CurrentUtilization.svelte';
    import TodayChart from '$lib/components/TodayChart.svelte';
    import Heatmap from '$lib/components/Heatmap.svelte';
    import DataTools from '$lib/components/DataTools.svelte';
    import AdminLogin from '$lib/components/AdminLogin.svelte';
    import { isAuthenticated, checkAuth } from '$lib/stores/auth';
    import { analytics } from '$lib/utils/analytics';

    let selectedWeeks = $state(4);
    onMount(() => { checkAuth(); });
</script>

<svelte:head>
    <title>Studio-Auslastung · AI Fitness Coburg</title>
    <meta name="description" content="Dein Überblick über die Auslastung im AI Fitness Coburg. Aktuelle Messwerte, Prognosen und die ruhigeren Trainingszeiten." />
</svelte:head>

<header>
    <a href="/" class="brand" aria-label="AI Fitness Coburg – Startseite">
        <img src="/AiFitness-logo_main-white.png" alt="AI Fitness" />
        <span class="brand-divider"></span>
        <span class="location">Coburg<span>Studio-Auslastung</span></span>
    </a>
    <AdminLogin />
</header>

<main id="main-content">
    <CurrentUtilization />
    <TodayChart />
    <section class="card heatmap-section" aria-labelledby="heatmap-title">
        <div class="card-header">
            <div>
                <h2 id="heatmap-title" class="card-title">Wochenübersicht</h2>
            </div>
            <label>
                <span class="sr-only">Zeitraum der Wochenübersicht</span>
                <select bind:value={selectedWeeks} onchange={() => analytics.heatmapWeeksChange(selectedWeeks)}>
                    <option value={1}>Letzte Woche</option>
                    <option value={2}>Letzte 2 Wochen</option>
                    <option value={4}>Letzte 4 Wochen</option>
                    <option value={8}>Letzte 8 Wochen</option>
                </select>
            </label>
        </div>
        <Heatmap weeks={selectedWeeks} />
    </section>
    {#if $isAuthenticated}<DataTools />{/if}
</main>

<footer>
    <p>Privates Projekt · Keine Verbindung zu AI Fitness.</p>
    <a href="https://instagram.com/ingomc" target="_blank" rel="noopener noreferrer">Mit ♥ von @ingomc <span aria-hidden="true">↗</span></a>
</footer>

<style>
    header { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 14px; }
    .brand { display: flex; align-items: center; gap: 12px; color: var(--text-primary); text-decoration: none; }
    .brand img { width: 70px; max-height: 32px; object-fit: contain; }
    .brand-divider { height: 25px; width: 1px; background: var(--border-color); }
    .location { font-weight: 600; font-size: .8rem; }
    .location span { display: block; color: var(--text-secondary); font-weight: 400; font-size: .65rem; }
    main { display: flex; flex-direction: column; gap: 14px; }
    .card-title { font-size: 1rem; }
    footer { display: flex; justify-content: space-between; flex-wrap: wrap; gap: 8px; color: var(--text-secondary); font-size: .65rem; margin-top: 20px; }
    footer a { text-decoration: none; color: var(--text-secondary); }
    footer a:hover { color: var(--text-primary); }
    @media (max-width: 700px) {
        header { margin-bottom: 9px; min-height: 30px; }
        .brand { gap: 8px; } .brand img { width: 52px; max-height: 25px; }
        .brand-divider { height: 22px; } .location { font-size: .73rem; }
        .location span { display: none; }
        main { gap: 10px; }
        .card-title { font-size: .92rem; }
        footer { margin-top: 16px; font-size: .6rem; }
    }
</style>
