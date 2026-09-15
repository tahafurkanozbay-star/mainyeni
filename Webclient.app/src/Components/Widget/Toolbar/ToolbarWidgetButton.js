import { Button, OverlayTrigger, Tooltip } from "react-bootstrap"

export const ToolbarWidgetButton=(props)=>{
    return <>
     <OverlayTrigger
          placement="left"
          overlay={
            <Tooltip id={`tooltip-left`}>
              {props.tooltipText}
            </Tooltip>
          }
        >
          <div className="toolbarwidget-button" onClick={(e)=>props.onClick()}>
                <img className="toolbarwidget-button-icon" src={"images/icons/toolbar/"+props.image}></img>
            </div>

        </OverlayTrigger>
    </>
}