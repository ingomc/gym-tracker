import { json, type RequestEvent } from '@sveltejs/kit';

export const POST = async ({ cookies }: RequestEvent) => {
    cookies.delete('auth_session', { path: '/' });
    return json({ success: true });
};
