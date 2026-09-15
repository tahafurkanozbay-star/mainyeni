import 'react-app-polyfill/stable';
import 'core-js/features/string/repeat';
import 'abortcontroller-polyfill';

import React from "react";
import ReactDOM from "react-dom";

import App from "./App";
import "./styles.css";

const rootElement = document.getElementById("root");
ReactDOM.render(<App />, rootElement);
