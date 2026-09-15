import { useEffect } from "react"
import { Container, NavDropdown, Form, Button, Navbar, Nav } from "react-bootstrap";
import { AuthBusiness } from "../Business/AuthBusiness";
import { Global } from "../Core/Global";

export const NavMenu = () => {

  useEffect(() => {
    
  }, []);

  return (<>
    <div className="app-version">v{Global.APP_VERSION}</div>
    <Navbar className="mainbar" variant="dark" expand="lg">
   
      <Container>
        <Navbar.Brand href="#/">{Global.App.Title1}<strong>{Global.App.Title2}</strong></Navbar.Brand> 
        <Navbar.Toggle aria-controls="mainbarScroll" />
        <Navbar.Collapse id="mainbarScroll">
          <Nav
            className="me-auto my-2 my-lg-0"
            style={{ maxHeight: '100px' }}
            mainbarScroll
          >
            <Nav.Link href="~/">Giriş</Nav.Link>

            <NavDropdown title="Konfigürasyon" id="mainbarScrollingDropdown">
              <NavDropdown.Item href="#/mapconfig">Harita Ayarları</NavDropdown.Item>
              <NavDropdown.Item href="#/configservices">Konfigürasyon Servisleri</NavDropdown.Item>
            </NavDropdown>

            <NavDropdown title="Katmanlar" id="mainbarScrollingDropdown">
              <NavDropdown.Item href="#/layers">Katmanlar</NavDropdown.Item>
              <NavDropdown.Divider />
              <NavDropdown.Item href="#/basemaps">Altlık Haritalar</NavDropdown.Item>
            </NavDropdown>

            <NavDropdown title="Kayıtlar" id="mainbarScrollingDropdown">
              <NavDropdown.Item href="#/feedbacks">Kullanıcı Geri Bildirimleri</NavDropdown.Item> 
            </NavDropdown>

            
            <NavDropdown title="Sistem" id="mainbarScrollingDropdown"> 
                <NavDropdown.Item href="#/adminaccount">Yönetici Hesap Ayarları</NavDropdown.Item>
                <NavDropdown.Item href="#/errorlogs">Hata Kayıtları</NavDropdown.Item>
            </NavDropdown>
            

            <Nav.Link href="#" className="align-right" onClick={(e)=>AuthBusiness.LogoutUser()}>Çıkış Yap</Nav.Link>
          </Nav>

        </Navbar.Collapse>
      </Container>
    </Navbar>
  </>);

}