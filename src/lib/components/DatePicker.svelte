<script lang="ts">
    import { onMount } from "svelte";

    interface AvailableDate {
        date: string;
        count: number;
    }

    let {
        selectedDate = null,
        onSelectDate,
        onGoToToday,
    }: {
        selectedDate: string | null;
        onSelectDate: (date: string) => void;
        onGoToToday: () => void;
    } = $props();

    let availableDates = $state<AvailableDate[]>([]);
    let availableDatesSet = $state<Set<string>>(new Set());
    let showPicker = $state(false);
    let calendarMonth = $state(new Date());
    let displayDate = $state<string | null>(null);

    // Update the set when availableDates changes
    $effect(() => {
        availableDatesSet = new Set(availableDates.map((d) => d.date));
    });

    // Update display date when selectedDate changes
    $effect(() => {
        let dateToFormat: Date;
        if (selectedDate) {
            const [year, month, day] = selectedDate.split("-").map(Number);
            dateToFormat = new Date(year, month - 1, day);
        } else {
            dateToFormat = new Date();
        }
        displayDate = dateToFormat.toLocaleDateString("de-DE", {
            weekday: "long",
            day: "numeric",
            month: "long",
        });
    });

    async function fetchAvailableDates() {
        try {
            const response = await fetch("/api/available-dates");
            if (response.ok) {
                const result = await response.json();
                availableDates = result.dates;
            }
        } catch (e) {
            console.error("Failed to fetch available dates", e);
        }
    }

    function selectDate(date: string) {
        showPicker = false;
        onSelectDate(date);
    }

    function goToToday() {
        showPicker = false;
        calendarMonth = new Date();
        onGoToToday();
    }

    function prevMonth() {
        const d = new Date(calendarMonth);
        d.setMonth(d.getMonth() - 1);
        calendarMonth = d;
    }

    function nextMonth() {
        const d = new Date(calendarMonth);
        d.setMonth(d.getMonth() + 1);
        calendarMonth = d;
    }

    function getCalendarDays(month: Date): {
        date: string;
        day: number;
        isCurrentMonth: boolean;
        hasData: boolean;
        isToday: boolean;
        isSelected: boolean;
    }[] {
        const year = month.getFullYear();
        const m = month.getMonth();
        const firstDay = new Date(year, m, 1);
        const lastDay = new Date(year, m + 1, 0);
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;

        const days: {
            date: string;
            day: number;
            isCurrentMonth: boolean;
            hasData: boolean;
            isToday: boolean;
            isSelected: boolean;
        }[] = [];

        // Add days from previous month to fill the first week
        const startDayOfWeek = (firstDay.getDay() + 6) % 7; // Monday = 0
        for (let i = startDayOfWeek - 1; i >= 0; i--) {
            const d = new Date(year, m, -i);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            days.push({
                date: dateStr,
                day: d.getDate(),
                isCurrentMonth: false,
                hasData: availableDatesSet.has(dateStr),
                isToday: dateStr === todayStr,
                isSelected: dateStr === selectedDate,
            });
        }

        // Add days of current month
        for (let i = 1; i <= lastDay.getDate(); i++) {
            const dateStr = `${year}-${String(m + 1).padStart(2, "0")}-${String(i).padStart(2, "0")}`;
            days.push({
                date: dateStr,
                day: i,
                isCurrentMonth: true,
                hasData: availableDatesSet.has(dateStr),
                isToday: dateStr === todayStr,
                isSelected: dateStr === selectedDate,
            });
        }

        // Add days from next month to complete the grid (fill to 42 days = 6 rows)
        const remaining = 42 - days.length;
        for (let i = 1; i <= remaining; i++) {
            const d = new Date(year, m + 1, i);
            const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
            days.push({
                date: dateStr,
                day: i,
                isCurrentMonth: false,
                hasData: availableDatesSet.has(dateStr),
                isToday: dateStr === todayStr,
                isSelected: dateStr === selectedDate,
            });
        }

        return days;
    }

    // Check if selected date is today
    function isToday(): boolean {
        if (!selectedDate) return true;
        const today = new Date();
        const todayStr = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
        return selectedDate === todayStr;
    }

    export function refresh() {
        fetchAvailableDates();
    }

    onMount(() => {
        fetchAvailableDates();
    });
</script>

<div class="date-picker-container">
    <button class="date-label-btn" onclick={() => (showPicker = !showPicker)}>
        {displayDate || "Laden..."}
        <svg
            width="12"
            height="12"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            stroke-width="2"
        >
            <path d="M6 9l6 6 6-6" />
        </svg>
    </button>

    {#if showPicker}
        <div class="calendar-dropdown">
            <div class="calendar-header">
                <button class="calendar-nav" onclick={prevMonth}>
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path d="M15 18l-6-6 6-6" />
                    </svg>
                </button>
                <span class="calendar-month">
                    {calendarMonth.toLocaleDateString("de-DE", {
                        month: "long",
                        year: "numeric",
                    })}
                </span>
                <button class="calendar-nav" onclick={nextMonth}>
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="2"
                    >
                        <path d="M9 18l6-6-6-6" />
                    </svg>
                </button>
            </div>
            <div class="calendar-weekdays">
                <span>Mo</span><span>Di</span><span>Mi</span><span>Do</span
                ><span>Fr</span><span>Sa</span><span>So</span>
            </div>
            <div class="calendar-days">
                {#each getCalendarDays(calendarMonth) as day}
                    <button
                        class="calendar-day"
                        class:other-month={!day.isCurrentMonth}
                        class:has-data={day.hasData}
                        class:is-today={day.isToday}
                        class:is-selected={day.isSelected}
                        disabled={!day.hasData}
                        onclick={() => day.hasData && selectDate(day.date)}
                    >
                        {day.day}
                    </button>
                {/each}
            </div>
            {#if !isToday()}
                <div class="calendar-footer">
                    <button class="today-btn" onclick={goToToday}
                        >Zurück zu Heute</button
                    >
                </div>
            {/if}
        </div>
    {/if}
</div>

<style>
    .date-picker-container {
        position: relative;
    }

    .date-label-btn {
        display: flex;
        align-items: center;
        gap: 0.5rem;
        font-size: 0.875rem;
        color: var(--text-secondary);
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.1);
        padding: 0.375rem 0.75rem;
        border-radius: 0.5rem;
        cursor: pointer;
        transition: all 0.2s;
    }

    .date-label-btn:hover {
        background: rgba(255, 255, 255, 0.05);
        border-color: rgba(255, 255, 255, 0.2);
        color: var(--text-primary, #fff);
    }

    .calendar-dropdown {
        position: absolute;
        top: calc(100% + 0.5rem);
        right: 0;
        background: var(--card-bg, #1a1a2e);
        border: 1px solid rgba(255, 255, 255, 0.1);
        border-radius: 0.75rem;
        padding: 0.75rem;
        z-index: 100;
        box-shadow: 0 10px 40px rgba(0, 0, 0, 0.4);
        min-width: 280px;
    }

    .calendar-header {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin-bottom: 0.75rem;
    }

    .calendar-nav {
        background: transparent;
        border: 1px solid rgba(255, 255, 255, 0.1);
        color: var(--text-secondary);
        width: 28px;
        height: 28px;
        border-radius: 0.375rem;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: all 0.2s;
    }

    .calendar-nav:hover {
        background: rgba(255, 255, 255, 0.05);
        color: var(--text-primary, #fff);
    }

    .calendar-month {
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--text-primary, #fff);
        text-transform: capitalize;
    }

    .calendar-weekdays {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 2px;
        margin-bottom: 0.5rem;
    }

    .calendar-weekdays span {
        text-align: center;
        font-size: 0.7rem;
        color: var(--text-secondary);
        padding: 0.25rem;
    }

    .calendar-days {
        display: grid;
        grid-template-columns: repeat(7, 1fr);
        gap: 2px;
    }

    .calendar-day {
        aspect-ratio: 1;
        display: flex;
        align-items: center;
        justify-content: center;
        background: transparent;
        border: none;
        border-radius: 0.375rem;
        font-size: 0.8rem;
        color: var(--text-primary, #fff);
        cursor: pointer;
        transition: all 0.15s;
    }

    .calendar-day:disabled {
        color: rgba(255, 255, 255, 0.2);
        cursor: not-allowed;
    }

    .calendar-day.other-month {
        color: rgba(255, 255, 255, 0.3);
    }

    .calendar-day.has-data:not(:disabled) {
        background: rgba(99, 102, 241, 0.15);
        font-weight: 500;
    }

    .calendar-day.has-data:not(:disabled):hover {
        background: rgba(99, 102, 241, 0.3);
    }

    .calendar-day.is-today {
        border: 1px solid var(--accent-color, #6366f1);
    }

    .calendar-day.is-selected {
        background: var(--accent-color, #6366f1) !important;
        color: white;
    }

    .calendar-footer {
        margin-top: 0.75rem;
        padding-top: 0.75rem;
        border-top: 1px solid rgba(255, 255, 255, 0.1);
        text-align: center;
    }

    .today-btn {
        background: var(--accent-color, #6366f1);
        color: white;
        border: none;
        padding: 0.375rem 0.75rem;
        border-radius: 0.375rem;
        font-size: 0.75rem;
        cursor: pointer;
        transition: opacity 0.2s;
    }

    .today-btn:hover {
        opacity: 0.8;
    }
</style>
