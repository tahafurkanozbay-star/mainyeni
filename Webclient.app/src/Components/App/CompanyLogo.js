import "./CompanyLogo.css";

export const CompanyLogo=()=>{
    return(<>
    {/*<img src="images/CBSbaskent.svg" style={{paddingTop:"2px"}} className="cbscompany-logo"  title="ABB CBS Portal" onClick={(e) => window.open("https://cbsbaskent.ankara.bel.tr", "_blank")} />
      */}
      <span onClick={(e) => window.open("https://cbsbaskent.ankara.bel.tr", "_blank")} className="cbs-logo"> <span className="cbs-logo-colour">CBS</span> BAŞKENT</span>
    </>)
}