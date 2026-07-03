import { createRoot } from 'react-dom/client';
import '@/shared/pages.css';
import { Popup } from './Popup';

createRoot(document.getElementById('root')!).render(<Popup />);
