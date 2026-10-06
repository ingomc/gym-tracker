export type UtilizationStatus = 'live' | 'closed' | 'stale' | 'unavailable';

export interface OpeningHours {
    startTime: string;
    endTime: string;
}

export interface UtilizationSourceSnapshot {
    checkedAt: Date;
    status: 'current' | 'missing' | 'error';
    openingHours?: OpeningHours;
    openingHoursCheckedAt?: Date;
}

const berlinClock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
});

function getLocalTime(date: Date) {
    const parts = Object.fromEntries(berlinClock.formatToParts(date).map(part => [part.type, part.value]));
    return {
        date: `${parts.year}-${parts.month}-${parts.day}`,
        weekday: parts.weekday,
        seconds: Number(parts.hour) * 3600 + Number(parts.minute) * 60 + Number(parts.second),
    };
}

function parseTime(time: string): number | null {
    const match = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(time);
    if (!match) return null;
    const [, hours, minutes, seconds = '0'] = match;
    if (Number(hours) > 24 || Number(minutes) > 59 || Number(seconds) > 59) return null;
    if (Number(hours) === 24 && (Number(minutes) !== 0 || Number(seconds) !== 0)) return null;
    return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

export function getPollIntervalMinutes(value = process.env.POLL_INTERVAL_MINUTES): number {
    const minutes = Number(value ?? 1);
    return Number.isInteger(minutes) && minutes >= 1 && minutes <= 59 ? minutes : 1;
}

export function getUtilizationStatus({
    now,
    lastUpdated,
    source,
    pollIntervalMinutes,
}: {
    now: Date;
    lastUpdated: Date | null;
    source: UtilizationSourceSnapshot | null;
    pollIntervalMinutes: number;
}): UtilizationStatus {
    const local = getLocalTime(now);
    // Verified Coburg schedule; prefer today's hours returned by AI Fitness.
    // https://www.ai-fitness.de/studios/coburg
    const weekend = local.weekday === 'Sat' || local.weekday === 'Sun';
    const defaultHours = { startTime: weekend ? '07:00:00' : '06:00:00', endTime: '22:00:00' };
    const sourceHours = source?.openingHours;
    const hoursCheckedAt = source?.openingHoursCheckedAt ?? source?.checkedAt;
    const useSourceHours = sourceHours && hoursCheckedAt && getLocalTime(hoursCheckedAt).date === local.date
        && parseTime(sourceHours.startTime) !== null && parseTime(sourceHours.endTime) !== null;
    const hours = useSourceHours ? sourceHours : defaultHours;
    const opening = parseTime(hours.startTime)!;
    const closing = parseTime(hours.endTime)!;

    const open = opening === closing || (opening < closing
        ? local.seconds >= opening && local.seconds < closing
        : local.seconds >= opening || local.seconds < closing);
    if (!open) return 'closed';

    // Allow one polling interval plus two minutes for scheduling/network delay.
    const maxAgeMs = (pollIntervalMinutes + 2) * 60_000;
    const sourceAge = source ? now.getTime() - source.checkedAt.getTime() : Infinity;
    if (source?.status === 'missing' && sourceAge >= 0 && sourceAge <= maxAgeMs) return 'unavailable';
    if (!lastUpdated) return 'unavailable';

    const readingAge = now.getTime() - lastUpdated.getTime();
    if (readingAge < 0 || readingAge > maxAgeMs) return 'stale';
    if (source?.status === 'error' && sourceAge >= 0 && sourceAge <= maxAgeMs) return 'stale';
    return 'live';
}
