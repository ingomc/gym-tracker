<script lang="ts">
    import { onMount } from "svelte";
    import CurrentUtilization from "$lib/components/CurrentUtilization.svelte";
    import TodayChart from "$lib/components/TodayChart.svelte";
    import Heatmap from "$lib/components/Heatmap.svelte";

    let selectedWeeks = $state(4);
    let lastRefresh = $state<Date | null>(null);

    function handleRefresh() {
        lastRefresh = new Date();
    }

    onMount(() => {
        lastRefresh = new Date();
    });
</script>

<svelte:head>
    <title>Gym Tracker - Auslastung</title>
</svelte:head>

<header>
    <div class="header-content">
        <h1>🏋️ AI Fitness Tracker</h1>
        <p class="subtitle">Finde die beste Zeit zum Trainieren</p>
    </div>
    <div class="header-actions">
        <button class="btn btn-ghost" onclick={handleRefresh}>
            <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
            >
                <path d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8" />
                <path d="M3 3v5h5" />
                <path d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16" />
                <path d="M16 21h5v-5" />
            </svg>
            Aktualisieren
        </button>
    </div>
</header>

<main>
    <div class="dashboard-grid">
        <aside>
            <CurrentUtilization refreshTrigger={lastRefresh} />
        </aside>

        <section class="main-content">
            <TodayChart refreshTrigger={lastRefresh} />
        </section>
    </div>

    <section class="heatmap-section">
        <div class="card">
            <div class="card-header">
                <span class="card-title">📊 Wöchentliche Auslastung</span>
                <select bind:value={selectedWeeks}>
                    <option value={1}>Letzte Woche</option>
                    <option value={2}>Letzte 2 Wochen</option>
                    <option value={4}>Letzte 4 Wochen</option>
                    <option value={8}>Letzte 8 Wochen</option>
                </select>
            </div>
            <Heatmap weeks={selectedWeeks} refreshTrigger={lastRefresh} />
        </div>
    </section>
</main>

<style>
    header {
        display: flex;
        justify-content: space-between;
        align-items: flex-start;
        margin-bottom: 2rem;
        flex-wrap: wrap;
        gap: 1rem;
    }

    .header-content h1 {
        margin-bottom: 0.25rem;
    }

    .subtitle {
        color: var(--text-secondary);
        font-size: 0.875rem;
    }

    .header-actions {
        display: flex;
        gap: 0.5rem;
    }

    main {
        display: flex;
        flex-direction: column;
        gap: 1.5rem;
    }

    aside {
        display: flex;
        flex-direction: column;
        gap: 1rem;
    }

    .main-content {
        min-height: 300px;
    }

    .heatmap-section {
        margin-top: 0.5rem;
    }
</style>
