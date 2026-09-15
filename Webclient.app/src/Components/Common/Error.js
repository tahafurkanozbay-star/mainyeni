import "./Error.css";

export const FullScreenError = ({ message = "Beklenmeyen bir hata oluştu." }) => (
    <div
        className="w-100 h-100 full-screen-div"
        role="alert"
        aria-live="assertive"
        aria-atomic="true"
    >
        <div className="ErrorFullScreenText">{message}</div>
    </div>
);
