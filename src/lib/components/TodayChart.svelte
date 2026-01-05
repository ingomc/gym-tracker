<script lang="ts">
    import { onMount } from "svelte";
    import { Chart, registerables } from "chart.js";

    Chart.register(...registerables);

    interface Reading {
        time: string;
        timestamp: string;
        hour: number;
        minute: number;
        percentage: number;
        level: string;
    }

    interface TodayRawData {
        date: string;
        dateFormatted: string;
        readings: Reading[];
        count: number;
    }

    let { refreshTrigger = null }: { refreshTrigger?: Date | null } = $props();

    let data = $state<TodayRawData | null>(null);
    let loading = $state(true);
    let error = $state<string | null>(null);
    let chartCanvas = $state<HTMLCanvasElement | null>(null);
    let chart: Chart | null = null;

    async function fetchData() {
        try {
            loading = true;
            error = null;
            const response = await fetch("/api/today-raw");
            if (!response.ok) throw new Error("Failed to fetch");
            data = await response.json();
            updateChart();
        } catch (e) {
            error = e instanceof Error ? e.message : "Unknown error";
        } finally {
            loading = false;
        }
    }

    function updateChart() {
        if (!chartCanvas || !data) return;

        // Create a full day of 5-minute slots (24h * 12 = 288 slots)
        const INTERVAL = 5; // minutes
        const allSlots: {
            label: string;
            value: number | null;
            color: string;
        }[] = [];

        // Create a map of existing readings by time string
        const readingMap = new Map<string, Reading>();
        for (const r of data.readings) {
            readingMap.set(r.time, r);
        }

        // Generate all 5-minute slots for 24h
        for (let h = 0; h < 24; h++) {
            for (let m = 0; m < 60; m += INTERVAL) {
                const timeStr = `${h.toString().padStart(2, "0")}:${m.toString().padStart(2, "0")}`;
                const reading = readingMap.get(timeStr);

                if (reading) {
                    let color = "rgba(239, 68, 68, 0.8)"; // red
                    if (reading.percentage <= 30)
                        color = "rgba(34, 197, 94, 0.8)"; // green
                    else if (reading.percentage <= 60)
                        color = "rgba(234, 179, 8, 0.8)"; // yellow

                    allSlots.push({
                        label: timeStr,
                        value: reading.percentage,
                        color,
                    });
                } else {
                    allSlots.push({
                        label: timeStr,
                        value: null,
                        color: "transparent",
                    });
                }
            }
        }

        const labels = allSlots.map((m) => m.label);
        const values = allSlots.map((m) => m.value);
        const colors = allSlots.map((m) => m.color);

        if (chart) {
            chart.data.labels = labels;
            chart.data.datasets[0].data = values;
            chart.data.datasets[0].backgroundColor = colors;
            chart.update();
        } else {
            chart = new Chart(chartCanvas, {
                type: "bar",
                data: {
                    labels,
                    datasets: [
                        {
                            label: "Auslastung %",
                            data: values,
                            backgroundColor: colors,
                            borderRadius: 1,
                            borderSkipped: false,
                            barPercentage: 1.0,
                            categoryPercentage: 1.0,
                        },
                    ],
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: {
                            display: false,
                        },
                        tooltip: {
                            backgroundColor: "rgba(26, 26, 46, 0.95)",
                            titleColor: "#fff",
                            bodyColor: "#a0a0b0",
                            borderColor: "rgba(255, 255, 255, 0.1)",
                            borderWidth: 1,
                            padding: 12,
                            cornerRadius: 8,
                            filter: (item) => item.parsed.y !== null,
                            callbacks: {
                                title: (items) => items[0]?.label || "",
                                label: (context) => {
                                    if (context.parsed.y === null) return "";
                                    const timeStr = labels[context.dataIndex];
                                    const reading = readingMap.get(timeStr);
                                    return [
                                        `Auslastung: ${context.parsed.y}%`,
                                        reading
                                            ? `Level: ${reading.level}`
                                            : "",
                                    ].filter(Boolean);
                                },
                            },
                        },
                    },
                    scales: {
                        y: {
                            beginAtZero: true,
                            max: 100,
                            grid: {
                                color: "rgba(255, 255, 255, 0.05)",
                            },
                            ticks: {
                                color: "#a0a0b0",
                                callback: (value) => `${value}%`,
                            },
                        },
                        x: {
                            grid: {
                                display: false,
                            },
                            ticks: {
                                color: "#a0a0b0",
                                maxRotation: 0,
                                autoSkip: true,
                                maxTicksLimit: 24,
                                callback: function (value, index) {
                                    // Show only full hours (every 12 slots = 1 hour with 5min interval)
                                    if (index % 12 === 0) {
                                        return `${Math.floor(index / 12)
                                            .toString()
                                            .padStart(2, "0")}:00`;
                                    }
                                    return "";
                                },
                            },
                        },
                    },
                },
            });
        }
    }

    onMount(() => {
        fetchData();
        const interval = setInterval(fetchData, 60000);
        return () => {
            clearInterval(interval);
            if (chart) chart.destroy();
        };
    });

    $effect(() => {
        if (refreshTrigger) {
            fetchData();
        }
    });

    $effect(() => {
        if (chartCanvas && data) {
            updateChart();
        }
    });
</script>

<div class="card">
    <div class="card-header">
        <span class="card-title">📈 Heute</span>
        {#if data}
            <span class="date-label">{data.dateFormatted}</span>
        {/if}
    </div>

    <div class="chart-container">
        {#if loading && !data}
            <div class="loading">
                <div class="spinner"></div>
            </div>
        {:else if error}
            <div class="error">
                <p>Fehler beim Laden</p>
                <button class="btn btn-ghost" onclick={fetchData}
                    >Erneut versuchen</button
                >
            </div>
        {:else}
            <canvas bind:this={chartCanvas}></canvas>
        {/if}
    </div>
</div>

<style>
    .chart-container {
        height: 280px;
        position: relative;
    }

    .loading,
    .error {
        position: absolute;
        inset: 0;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 1rem;
    }

    .error p {
        color: var(--text-secondary);
    }

    .date-label {
        font-size: 0.875rem;
        color: var(--text-secondary);
    }

    canvas {
        width: 100% !important;
        height: 100% !important;
    }
</style>
