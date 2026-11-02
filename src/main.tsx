import { render } from 'preact';
import 'maplibre-gl/dist/maplibre-gl.css';
import { CURRENT_REGION } from './config/regions';
import './ui/styles.css';
import { App } from './ui/App';

document.title = CURRENT_REGION.title;
render(<App />, document.getElementById('app')!);
