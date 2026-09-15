import { useEffect, useState } from "react";
import { Form } from "react-bootstrap";

export const ListPagination = (props) => {

    const [rowCount, setRowCount] = useState(0);
    const [pageSize, setPageSize] = useState(1);
    const [selectedPage, setSelectedPage] = useState(1);
    const [pageCount, setPageCount] = useState(1);

    useEffect(() => {

        setRowCount(props.rowCount);
        setPageSize(props.pageSize);
        setSelectedPage(props.selectedPage);
        setPageCount(Math.ceil(props.rowCount / props.pageSize))
        
    }, []);

    return (<div>
        <table style={{float:'right'}}>
            <tbody>
            <tr>
                <td>
                    <Form.Select defaultValue={selectedPage} style={{ width: '75px', float: 'left' }} onChange={(e)=>props.OnChange(e)}>
                        {[...Array(pageCount)].map((x, i) =>
                            <option key={i} value={i+1}>{i+1}</option>
                        )}
                    </Form.Select>
                </td>
                <td>&nbsp;/&nbsp;</td>
                <td>&nbsp;
                {pageCount}
                </td>
            </tr>
            </tbody>
        </table>

    </div>);

}