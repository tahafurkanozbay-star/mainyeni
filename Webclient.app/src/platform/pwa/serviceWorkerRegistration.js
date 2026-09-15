export const registerServiceWorker = () => {
    if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return Promise.resolve(null);
    if (process.env.NODE_ENV !== 'production') return Promise.resolve(null);

    return window.addEventListener ? navigator.serviceWorker.register(`${process.env.PUBLIC_URL || ''}/service-worker.js`, { scope: './' }) : Promise.resolve(null);
};
