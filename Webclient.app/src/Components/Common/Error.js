import "./Error.css";
export const FullScreenError = (props) => {

    return (<div className="w-100 h-100 full-screen-div">
        <div className="ErrorFullScreenText">{props.message}</div>
    </div>);

}