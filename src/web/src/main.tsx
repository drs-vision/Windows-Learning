import { render } from 'preact';
import { Scholar } from './scholar/Scholar';
import { ParentConsole } from './parent/ParentConsole';

const app = new URLSearchParams(location.search).get('app') ?? 'scholar';
document.documentElement.dataset.app = app;

render(app === 'parent' ? <ParentConsole /> : <Scholar />, document.getElementById('app')!);
