import { json, type RequestEvent } from '@sveltejs/kit';

export const GET = async ({ cookies }: RequestEvent) => {
    const session = cookies.get('auth_session');
    return json({ authenticated: session === 'valid' });
};
