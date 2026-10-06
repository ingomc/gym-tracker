/** All calendar dates and wall-clock times in the tracker belong to the studio. */
export const STUDIO_TIME_ZONE = 'Europe/Berlin';

const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone: STUDIO_TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

export function isValidStudioDate(value: string): boolean {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T12:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function requireDate(value: string): void {
    if (!isValidStudioDate(value)) throw new RangeError('Datum muss ein gültiger Kalendertag im Format YYYY-MM-DD sein.');
}

export function studioWeekday(date: string): number {
    requireDate(date);
    return new Date(`${date}T12:00:00Z`).getUTCDay();
}

export function studioParts(date = new Date()): { date: string; hour: number; minute: number; weekday: number } {
    const parts = Object.fromEntries(formatter.formatToParts(date).map(part => [part.type, part.value]));
    const day = `${parts.year}-${parts.month}-${parts.day}`;
    return { date: day, hour: Number(parts.hour), minute: Number(parts.minute), weekday: studioWeekday(day) };
}

export function studioDateString(date = new Date()): string {
    return studioParts(date).date;
}

export function addStudioDays(date: string, days: number): string {
    requireDate(date);
    if (!Number.isInteger(days)) throw new RangeError('Tage müssen ganzzahlig sein.');
    const result = new Date(`${date}T12:00:00Z`);
    result.setUTCDate(result.getUTCDate() + days);
    return result.toISOString().slice(0, 10);
}

function midnight(date: string): Date {
    const target = new Date(`${date}T00:00:00Z`).getTime();
    let instant = target;
    // Resolve Berlin midnight independently of the host timezone and DST offset.
    for (let attempt = 0; attempt < 3; attempt++) {
        const parts = studioParts(new Date(instant));
        const represented = new Date(`${parts.date}T00:00:00Z`).getTime()
            + (parts.hour * 60 + parts.minute) * 60_000;
        instant += target - represented;
    }
    return new Date(instant);
}

/** Half-open bounds; DST days can contain 23 or 25 hours. */
export function studioDayBounds(date: string): { start: Date; end: Date } {
    requireDate(date);
    return { start: midnight(date), end: midnight(addStudioDays(date, 1)) };
}

export function studioOpeningHours(date: string): { startHour: number; endHour: number } {
    const weekday = studioWeekday(date);
    return { startHour: weekday === 0 || weekday === 6 ? 7 : 6, endHour: 22 };
}
