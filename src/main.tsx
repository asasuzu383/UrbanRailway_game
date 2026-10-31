import { render } from 'preact';
import 'maplibre-gl/dist/maplibre-gl.css';
import './ui/styles.css';
import { App } from './ui/App';

render(<App />, document.getElementById('app')!);
