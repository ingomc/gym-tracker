const CLASSES_URL = process.env.CLASSES_URL || 'https://api.ai-fitness.de/api/studios/coburg/classes/slots.json';
const CACHE_MS = 10 * 60_000;

export interface StudioClass {
    id: number;
    start: string;
    end: string;
    title: string;
    category: string | null;
    instructors: string[];
    booked: number | null;
    max: number | null;
    bookingOpen: boolean;
    bookingOpensAt: string | null;
    bookingUrl: string | null;
}

const isTime = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const count = (value: unknown) => (typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : null);

/** Keeps only the fields the dashboard shows; malformed slots are dropped, not guessed. */
export function normalizeClasses(payload: unknown): StudioClass[] {
    const slots = (payload as { slots?: unknown } | null)?.slots;
    if (!Array.isArray(slots)) throw new Error('Invalid class schedule response');
    return slots.flatMap((slot): StudioClass[] => {
        if (!slot || typeof slot !== 'object') return [];
        const item = slot as Record<string, unknown>;
        if (!isTime(item.start) || !isTime(item.end) || typeof item.title !== 'string' || !item.title.trim()) return [];
        const url = typeof item.bookingUrl === 'string' && /^https:\/\//.test(item.bookingUrl) ? item.bookingUrl : null;
        return [{
            id: Number(item.id),
            start: item.start,
            end: item.end,
            title: item.title.trim(),
            category: typeof item.category === 'string' ? item.category : null,
            instructors: Array.isArray(item.instructors) ? item.instructors.filter((name): name is string => typeof name === 'string') : [],
            booked: count(item.booked),
            max: count(item.max),
            bookingOpen: item.bookingOpen === true,
            bookingOpensAt: isTime(item.bookingOpensAt) ? item.bookingOpensAt : null,
            bookingUrl: url,
        }];
    }).sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
}

let cache: { fetchedAt: number; classes: StudioClass[] } | null = null;
let pending: Promise<StudioClass[]> | null = null;

/** Class bookings change slowly; one shared request per ten minutes is plenty. */
export async function getUpcomingClasses(now = Date.now()): Promise<StudioClass[]> {
    if (!cache || now - cache.fetchedAt >= CACHE_MS) {
        pending ??= fetch(CLASSES_URL, { signal: AbortSignal.timeout(8000), headers: { Accept: 'application/json' } })
            .then(async response => {
                if (!response.ok) throw new Error(`Class schedule responded with status ${response.status}`);
                const classes = normalizeClasses(await response.json());
                cache = { fetchedAt: Date.now(), classes };
                return classes;
            })
            .finally(() => { pending = null; });
        try {
            await pending;
        } catch (error) {
            // A stale schedule beats none; without any cache the caller reports unavailability.
            if (!cache) throw error;
            console.error('[Classes] Refresh failed, serving cached schedule:', error);
        }
    }
    return cache!.classes.filter(item => Date.parse(item.end) > now);
}
