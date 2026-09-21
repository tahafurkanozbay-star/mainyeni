import { Container, Nav, NavDropdown, Navbar } from 'react-bootstrap';

import { AuthBusiness } from '../Business/AuthBusiness';
import { Global } from '../Core/Global';

export const NavMenu = () => (
  <>
    <div className="app-version" aria-label={`Uygulama sürümü ${Global.APP_VERSION}`}>
      v{Global.APP_VERSION}
    </div>
    <Navbar className="mainbar" variant="dark" expand="lg">
      <Container>
        <Navbar.Brand href="#/">
          {Global.App.Title1}<strong>{Global.App.Title2}</strong>
        </Navbar.Brand>
        <Navbar.Toggle aria-controls="mainbarScroll" />
        <Navbar.Collapse id="mainbarScroll">
          <Nav className="me-auto my-2 my-lg-0">
            <Nav.Link href="#/">Giriş</Nav.Link>
            <NavDropdown title="Konfigürasyon" id="admin-config-menu">
              <NavDropdown.Item href="#/mapconfig">Harita Ayarları</NavDropdown.Item>
              <NavDropdown.Item href="#/configservices">Konfigürasyon Servisleri</NavDropdown.Item>
              <NavDropdown.Item href="#/takbisconfig">TAKBİS Ayarları</NavDropdown.Item>
            </NavDropdown>
            <NavDropdown title="Katmanlar" id="admin-layer-menu">
              <NavDropdown.Item href="#/layers">Katmanlar</NavDropdown.Item>
              <NavDropdown.Item href="#/basemaps">Altlık Haritalar</NavDropdown.Item>
            </NavDropdown>
            <Nav.Link href="#/syslogs">Sistem Kayıtları</Nav.Link>
            <button
              type="button"
              className="nav-link align-right border-0 bg-transparent"
              onClick={() => AuthBusiness.LogoutUser()}
            >
              Çıkış Yap
            </button>
          </Nav>
        </Navbar.Collapse>
      </Container>
    </Navbar>
  </>
);
