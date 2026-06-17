import { mount } from 'svelte'
import './app.css'
import 'highlight.js/styles/atom-one-dark.css'
import App from './App.svelte'

const app = mount(App, {
  target: document.getElementById('app'),
})

export default app
