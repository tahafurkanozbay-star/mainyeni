export interface SkipNavigationTarget {
    id: string;
    label: string;
    target: HTMLElement;
}

export interface SkipNavigationOptions {
    container: HTMLElement;
    targets: readonly SkipNavigationTarget[];
    className?: string;
    onNavigate?: (id: string) => void;
}

export interface SkipNavigationController {
    refresh(targets?: readonly SkipNavigationTarget[]): void;
    destroy(): void;
}

const ensureFocusable = (target: HTMLElement): (() => void) => {
    const previous = target.getAttribute("tabindex");
    if (target.tabIndex < 0 && previous === null) target.setAttribute("tabindex", "-1");
    return () => {
        if (previous === null) target.removeAttribute("tabindex");
        else target.setAttribute("tabindex", previous);
    };
};

export const createSkipNavigation = (options: SkipNavigationOptions): SkipNavigationController => {
    let targets = [...options.targets];
    let destroyed = false;
    const cleanups = new Map<string, () => void>();

    const render = (): void => {
        options.container.replaceChildren();
        cleanups.forEach((cleanup) => cleanup());
        cleanups.clear();
        const seen = new Set<string>();
        for (const item of targets) {
            const id = item.id.trim();
            const label = item.label.trim();
            if (!id || !label || seen.has(id) || !item.target.isConnected) continue;
            seen.add(id);
            if (!item.target.id) item.target.id = id;
            const restore = ensureFocusable(item.target);
            cleanups.set(id, restore);
            const link = item.target.ownerDocument.createElement("a");
            link.href = `#${item.target.id}`;
            link.textContent = label;
            link.dataset.skipNavigation = id;
            if (options.className) link.className = options.className;
            link.addEventListener("click", (event) => {
                event.preventDefault();
                item.target.focus({ preventScroll: true });
                item.target.scrollIntoView({ block: "start", behavior: "auto" });
                options.onNavigate?.(id);
            });
            options.container.append(link);
        }
    };

    render();
    return {
        refresh: (nextTargets) => {
            if (destroyed) return;
            if (nextTargets) targets = [...nextTargets];
            render();
        },
        destroy: () => {
            if (destroyed) return;
            destroyed = true;
            options.container.replaceChildren();
            cleanups.forEach((cleanup) => cleanup());
            cleanups.clear();
        }
    };
};
