import { MdOutlineApps } from "react-icons/md";
import { Global } from "../../Core/Global";
import {
  hashHref,
  routesForGroup,
  type AdminRouteGroup,
} from "../../platform/routeManifest";

const groups: ReadonlyArray<Readonly<{ id: AdminRouteGroup; title: string }>> = [
  { id: "configuration", title: "Konfigürasyon" },
  { id: "layers", title: "Katmanlar" },
  { id: "system", title: "Sistem" },
];

export const HomePage = () => (
  <main className="page">
    <header className="page-title">
      <MdOutlineApps aria-hidden="true" />
      <span>
        {Global.App.Title1}<strong>{Global.App.Title2}</strong> &gt; Giriş
      </span>
    </header>

    <div className="page-body">
      {groups.map((group) => {
        const routes = routesForGroup(group.id);
        if (!routes.length) return null;
        return (
          <section className="main-page-cards" key={group.id} aria-labelledby={`group-${group.id}`}>
            <div className="main-page-card">
              <h2 className="main-page-card-title" id={`group-${group.id}`}>
                {group.title}
              </h2>
              <div className="main-page-card-body">
                {routes.map((route) => (
                  <p className="main-page-card-link" key={route.id}>
                    <a href={hashHref(route)}>{route.label}</a>
                  </p>
                ))}
              </div>
            </div>
          </section>
        );
      })}
    </div>
  </main>
);
