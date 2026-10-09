import { Component, Fragment } from "react";
import { isChunkError, reloadOnceForChunkError } from "../lib/chunk-errors.js";
import { reportClientError } from "../lib/client-errors.js";

/**
 * Ошибка при отрисовке → fallback({ error, reset }) вместо белого экрана и отчёт на сервер.
 * Не загрузился модуль новой сборки — одна автоматическая перезагрузка страницы.
 * reset() рисует детей заново (кнопка «Обновить раздел» в админке).
 */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null, attempt: 0 };
    this.reset = this.reset.bind(this);
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    if (isChunkError(error) && reloadOnceForChunkError()) return;
    reportClientError(error, { kind: "boundary:" + (this.props.name || "app"), componentStack: info && info.componentStack });
  }

  reset() {
    this.setState((state) => ({ error: null, attempt: state.attempt + 1 }));
  }

  render() {
    if (this.state.error) return this.props.fallback({ error: this.state.error, reset: this.reset });
    return <Fragment key={this.state.attempt}>{this.props.children}</Fragment>;
  }
}
