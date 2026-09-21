import { useEffect } from "react";
import { AiOutlineCheckSquare } from "react-icons/ai";
import { BiSquare } from "react-icons/bi";

export const Checkbox = (props) => {

    useEffect(() => {

    }, [props]);


    return (<>
        <div onClick={(e)=>props.toggle(e)}>
            {props.checked ? <AiOutlineCheckSquare className="checkbox" ></AiOutlineCheckSquare>
                : <BiSquare className="checkbox"></BiSquare>
            }
            <span>{props.text}</span>
        </div>
    </>)

}