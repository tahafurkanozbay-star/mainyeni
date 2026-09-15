import React, { useState } from "react";
import { BiX } from "react-icons/bi";
import {TextHelper} from "../Core/Toolbox/TextHelper";
import "./FileUpload.css";

// drag drop file component
export const FileUpload = (props) => {
    
    const controlId= TextHelper.CreateRandomNumber();
    // drag state
    const [dragActive, setDragActive] = React.useState(false);
    // ref
    const inputRef = React.useRef(null);

    const [files, setFiles] = useState(null);

    // handle drag events
    const handleDrag = function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (e.type === "dragenter" || e.type === "dragover") {
            setDragActive(true);
        } else if (e.type === "dragleave") {
            setDragActive(false);
        }
    };

    // triggers when file is dropped
    const handleDrop = function (e) {
        e.preventDefault();
        e.stopPropagation();
        setDragActive(false);
        if (e.dataTransfer.files && e.dataTransfer.files[0]) {
            
            setFiles(e.dataTransfer.files);
            props.setFiles(e.dataTransfer.files);
            // handleFiles(e.dataTransfer.files);
        }
    };

    // triggers when file is selected with click
    const handleChange = function (e) {
        e.preventDefault();
        if (e.target.files && e.target.files[0]) {
            setFiles(e.target.files);
            props.setFiles(e.target.files);
            // handleFiles(e.target.files);
        }
    };

    // triggers the input when the button is clicked
    const onButtonClick = () => {
        inputRef.current.click();
    };

    const removeFile=(e)=>{
        e.preventDefault();
        e.stopPropagation();
        setFiles(null);
        props.setFiles(null);
    }

    return (
        <div>
            <form id={"form-file-upload"+controlId} className="form-file-upload" onDragEnter={handleDrag} onSubmit={(e) => e.preventDefault()}>
                <input ref={inputRef} type="file" id={"input-file-upload"+controlId} className="input-file-upload" multiple={false} onChange={handleChange} />
                <label id={"label-file-upload"+controlId} htmlFor={"input-file-upload"+controlId} className={dragActive ? "drag-active label-file-upload" : "label-file-upload"}>
                    <div>
                        {
                            files && <p><div onClick={(e)=>removeFile(e)} className="btn btn-outline-secondary"> {files[0].name} &nbsp;<BiX title="Vazgeç"></BiX></div></p>
                        }
                        <p>Dosyalarınızı buraya sürükleyip bırakın</p>
                        <button className="upload-button" onClick={onButtonClick}>ya da yüklemek için bir dosya seçin</button>
                    </div>
                </label>
                {dragActive && <div id={"drag-file-element"+controlId} className="drag-file-element" onDragEnter={handleDrag} onDragLeave={handleDrag} onDragOver={handleDrag} onDrop={handleDrop}></div>}

            </form>

        </div>

    );
};