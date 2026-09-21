import axios from 'axios';

export function Get(_url) {
    return axios.get(_url);
}

export function Post(_url, _data, _method) {
    return axios.post(_url);
}