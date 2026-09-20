import { Container, Nav, NavDropdown, Navbar } from "react-bootstrap";
import { AuthBusiness } from "../Business/AuthBusiness";
import { Global } from "../Core/Global";
import {
  getAdminRoute,
  hashHref,
  routesForGroup,
  type AdminRouteDefinition,
} from "../platform/routeManifest";

const RouteItem = ({ route }: { readonly route: AdminRouteDefinition }) => (
  <NavDropdown.Item href={hashHref(route)}>
    {route.label}
  </NavDropdown.Item>
);

export const NavMenu = () => {
  const configuration = routesForGroup("configuration");
  const layers = routesForGroup("layers");
  const system = routesForGroup("system");

  return (
    <>
      <div className="app-version" aria-label={`Uygulama sürümü ${Global.APP_VERSION}`}>
        v{Global.APP_VERSION}
      </div>
      <Navbar className="mainbar" variant="dark" expand="lg">
        <Container>
          <Navbar.Brand href={hashHref(getAdminRoute("home"))}>
            {Global.App.Title1}<strong>{Global.App.Title2}</strong>
          </Navbar.Brand>
          <Navbar.Toggle aria-controls="admin-main-navigation" />
          <Navbar.Collapse id="admin-main-navigation">
            <Nav className="me-auto my-2 my-lg-0" style={{ maxHeight: "100px" }}>
              <Nav.Link href={hashHref(getAdminRoute("home"))}>Giriş</Nav.Link>

              <NavDropdown title="Konfigürasyon" id="admin-nav-configuration">
                {configuration.map((route) => <RouteItem key={route.id} route={route} />)}
              </NavDropdown>

              <NavDropdown title="Katmanlar" id="admin-nav-layers">
                {layers.map((route) => <RouteItem key={route.id} route={route} />)}
              </NavDropdown>

              <NavDropdown title="Sistem" id="admin-nav-system">
                {system.map((route) => <RouteItem key={route.id} route={route} />)}
              </NavDropdown>

              <Nav.Link
                as="button"
                className="align-right border-0 bg-transparent"
                onClick={() => AuthBusiness.LogoutUser()}
              >
                Çıkış Yap
              </Nav.Link>
            </Nav>
          </Navbar.Collapse>
        </Container>
      </Navbar>
    </>
  );
};
