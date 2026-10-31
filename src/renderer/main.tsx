import { render } from 'solid-js/web';
import { App } from './App';
import { Overlay } from './components/Overlay';
import { startStore } from './store';

startStore();
const root = document.getElementById('root')!;
if (location.hash === '#overlay') {
  document.body.classList.add('overlay');
  render(() => <Overlay />, root);
} else {
  render(() => <App />, root);
}
